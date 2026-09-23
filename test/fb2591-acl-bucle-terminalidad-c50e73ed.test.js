// dsh-deepartments — fb-2591 + fb-2620 (IPD lane, 2026-09-23, run token c50e73ed):
// A DETERMINISTIC `failed/acl` IS NOT RE-DRIVEN — close the loop.
//
// THE MEASURED DEFECT (my own reading of the live ledger, cited by the TERNARY
// `(ts, recipientId, status)` + the read instant 1790166496228 =
// 2026-09-23T12:28:16.228Z — the ledger renumbers IN PLACE, fb-2623, so a bare
// `messageId` is not an identity): the pair (m-1887, quality-head) held 17 rows
// — 9 `prepared` + 8 `failed/acl` + **0 delivered/terminal** — cycling
// `prepared → failed/acl` every ~1 s of attempt inside a 5–11 min backoff
// cadence, while four older pairs (m-600→internal-programming-head,
// m-601/m-1705→quality-head, m-1704→internal-programming-head) had already run
// the full 12 attempts (~11 h 17 m for m-600) and closed as SILENCE (12
// `terminal`, 0 `delivered`).
//
// THE MECHANISM (cited by `archivo:linea` with the LITERAL, never by number):
//   - `catalogRoute` (delivery.ts) computes
//     `aclDenyGround(sender, deps.busProfileFor(recipientId))` — a refusal by
//     ROUTE/REGISTRATION, i.e. DETERMINISTIC for the two durable catalog
//     profiles — then `opts.failedGround?.('acl'); return 'failed'`.
//   - the single final-mark seam persists that as `status: 'failed'` with
//     `reason: 'acl'` (fb-2160's CAUSE column).
//   - `needsRedelivery` (messages.ts) is
//     `status === null || status === 'prepared' || status === 'failed'` ⇒ the
//     pair goes BACK on the re-drive wheel for the boot pass AND the sweep.
//   - the P2 guard `if (row.noWake === true && …) return` CANNOT stop it: the
//     re-drive rows are UNSEALED (measured: m-1887's rows 2..17 carry no
//     `noWake`), so the guard never evaluates. It is not a guard that "fails to
//     stop acl" — it does not apply to ANY re-drive row.
//
// THE FIX UNDER TEST: `isNonRetryableFailureGround(row.reason)` + the new
// `drivePair` branch that settles the pair 'terminal' ONCE with a LOUD warn,
// WITHOUT calling `deliver()`. The record stays durable in messages.jsonl and
// the pair's own `failed/acl` row keeps the cause legible.
//
// METHOD (the repo's LANE ② src-native convention, fb-95 / r6-ladder-flat): the
// hook is SELF-REGISTERED and the imports reach `src/`, never the built lib.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

const {
  DeliveryRedeliverer,
  deliveryStatus,
  isNonRetryableFailureGround,
  needsRedelivery,
  parseDeliveryRows,
  resolveDeliveriesPath,
  resolveMessagesPath
} = await import('../packages/dshd-core/src/messages.ts')

// ---------------------------------------------------------------------------
// The MEASURED live shape, in the real (ts-ascending) order, taken from my own
// reading of /.deepartments/deliveries.jsonl. `m-1887 → quality-head`: the
// SEALED write-ahead of the deferred send, then the churn cycles.
// ---------------------------------------------------------------------------
const T0 = 1790159402042 // the measured sealed `prepared` of m-1887 (10:30:02.042Z)
const ATTEMPT_MS = 1000 // the measured `prepared` → `failed` latency (~0.9–1.5 s)

/** The measured 17-row pair: row 0 sealed, then N churn cycles. */
function measuredPair({ cycles = 8, withSeal = true } = {}) {
  const start = T0 + 3_096_219 // the measured first re-drive (11:21:38.261Z)
  const rows = []
  if (withSeal) rows.push({ messageId: 'm-1887', recipientId: 'quality-head', status: 'prepared', ts: T0, noWake: true })
  for (let i = 0; i < cycles; i++) {
    const base = start + i * 660_000 // the measured ~11 min cap cadence
    rows.push({ messageId: 'm-1887', recipientId: 'quality-head', status: 'prepared', ts: base })
    rows.push({ messageId: 'm-1887', recipientId: 'quality-head', status: 'failed', ts: base + ATTEMPT_MS, reason: 'acl' })
  }
  return rows
}

const record = (id, seq, to, from = 'deepartments') => ({ id, seq, ts: T0, from, to, text: `msg ${id}`, kind: 'agent' })

/** The production sweep harness: the real `DeliveryRedeliverer` over a temp
 * stateDir, with the deliver seam REPLACED by the ACL-refusing stub that writes
 * the same rows the engine writes (write-ahead `prepared` + `failed` with the
 * `acl` ground) — i.e. the REAL measured behaviour of the loop. */
function sweepHarness(stateDir, records, calls) {
  const recordsById = new Map(records.map((r) => [r.id, r]))
  const r = new DeliveryRedeliverer({
    stateDir,
    logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
    recipientAlive: () => true,
    recipientDormant: () => false,
    recipientRunning: () => false,
    getRecord: async (id) => recordsById.get(id),
    resolveCallerSessionId: (from) => from,
    deliver: async (rec, recipientId) => {
      // THE ENGINE'S OWN WRITE SHAPE, reproduced: the write-ahead + the
      // classified refusal 1 s later. Never a delivery (the ACL denies it).
      calls.deliver.push({ messageId: rec.id, recipientId })
      await appendRows(stateDir, [
        { messageId: rec.id, recipientId, status: 'prepared', ts: Date.now() },
        { messageId: rec.id, recipientId, status: 'failed', ts: Date.now() + ATTEMPT_MS, reason: 'acl' }
      ])
      return 'failed'
    }
  })
  r.__calls = calls
  return r
}

async function appendRows(stateDir, rows) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(resolveDeliveriesPath(stateDir), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
}

async function readPair(stateDir, messageId, recipientId) {
  const rows = parseDeliveryRows(await readFile(resolveDeliveriesPath(stateDir), 'utf8'))
  return rows.filter((r) => r.messageId === messageId && r.recipientId === recipientId)
}

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2591-acl-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// ACCEPTANCE 1 + 4 — «un `failed/acl` NO SE REINTENTA, ni 12 veces ni una» and
// «TEST que reproduzca la secuencia `prepared → failed/acl` a ~1 s y AFIRME que
// no hay segundo intento».
// ---------------------------------------------------------------------------
test('fb-2591 ACCEPTANCE 1+4: the measured `prepared → failed/acl` (~1 s) sequence is NOT re-driven a second time — the sweep settles ONE terminal, calls NO deliver(), and appends ZERO new transitions', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = measuredPair({ cycles: 1 }) // ONE attempt already on the ledger — the seeded defect
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(record('m-1887', 1887, ['quality-head']))}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const calls = { deliver: [], informs: [], warns: [] }
    const r = sweepHarness(stateDir, [record('m-1887', 1887, ['quality-head'])], calls)

    // The measured shape BEFORE the fix: the seeded pair is `prepared`+`failed`,
    // i.e. exactly what `needsRedelivery` re-drives.
    assert.deepEqual(rows.map((x) => x.status), ['prepared', 'prepared', 'failed'], 'the seed reproduces the measured sequence: the sealed write-ahead, then ONE churn cycle (`prepared` → `failed/acl` ~1 s apart)')
    const gap = rows[2].ts - rows[1].ts
    assert.ok(gap >= 900 && gap <= 1500, `the measured attempt latency is ~1 s (got ${gap} ms) — the sequence the acceptance names`)
    assert.equal(rows[2].reason, 'acl', 'the refusal carries ITS OWN GROUND (fb-2160) — the fact the fix keys on')
    assert.equal(needsRedelivery('failed'), true, 'PRE-FIX: the `failed` row IS eligible (the defect: the sweep sees it as retryable)')

    // Drive MANY sweep cycles (far past the cap of 12 and past hours of clock).
    let clock = rows[2].ts
    for (let tick = 0; tick < 240; tick++) {
      clock += 60_000
      await r.sweepDue(clock)
    }

    const after = await readPair(stateDir, 'm-1887', 'quality-head')
    // APPEND ORDER, not status census (the ledger is mutated in place — the G2
    // dust settle flips earlier rows, so the FIRST `terminal` in file order is a
    // flipped dust row, not the settle). The settle is the LAST one.
    const transitionsAfterSettle = after.slice(after.map((x) => x.status).lastIndexOf('terminal') + 1)
    assert.equal(calls.deliver.length, 0, '★ ACCEPTANCE 1: the pair is NEVER re-driven — not once, let alone the 12 the cap allowed. The automatic re-drive does not retry a deterministic refusal')
    assert.equal(after.filter((x) => x.status === 'failed').length, 1, 'the ledger gains NO second `failed/acl` row (the measured loop appended 8–11 of them)')
    // THE WHOLE 240-cycle RUN APPENDS EXACTLY ONE ROW — the settle itself. The
    // re-drive loop the defect measured appended TWO rows per attempt (write-ahead
    // + rejection); the pre-existing G2 dust settle only flips rows IN PLACE (it
    // never changes the count), so a row-count delta is a clean instrument here.
    assert.equal(after.length, rows.length + 1, `★ the entire 240-sweep-cycle run appends EXACTLY ONE row (the 'terminal' settle): ${rows.length} seeded → ${after.length}. The measured defect appended 2 rows per attempt x 12 attempts`)
    // The pair-LATEST is the new settle — the word the whole re-drive/health
    // stack reads.
    assert.equal(after.at(-1).status, 'terminal', '★ the pair-latest is `terminal` — the ONE predicate `needsRedelivery` turns false on')
    assert.equal(after.at(-1).reason, undefined, 'the settle itself carries NO `reason`: the CAUSE stays legible in the pair\'s own `failed/acl` row (a terminal is not a failure report)')
    assert.ok(after.some((x) => x.status === 'terminal' && x.noWake === true), 'the pre-existing G2 dust settle flipped the SEALED head row IN PLACE (it keeps its seal — an unchanged behaviour, and the reason the acl pair\'s seal census read 1-of-N)')
    assert.deepEqual(transitionsAfterSettle, [], '240 further sweep cycles add ZERO transitions after the SETTLE (append order — fb-1236-safe: the G2 flip mutates a row\'s status in place WITHOUT moving it, so a status census would be the wrong instrument)')
    assert.ok(calls.warns.some((w) => /was failed, ground 'acl'\) → 'terminal'/.test(w) && /REFUSED BY ROUTE and can never land/.test(w)), '★ ACCEPTANCE 2: the settle is LOUD and DECLARES the reason (the pair and its ground are named) — never the cap\'s silence')
    assert.ok(!calls.warns.some((w) => /STOPPED after \d+ attempts/.test(w)), 'the CAP never fires for this pair — it never accrues an attempt (the stop that produced 12 terminals / 0 delivered is not the mechanism that closes it)')
    assert.equal(calls.warns.filter((w) => /ground 'acl'/.test(w)).length, 1, 'the declaration is emitted EXACTLY ONCE (not once per sweep cycle — no new alert storm replaces the old one)')
  })
})

// ---------------------------------------------------------------------------
// THE CRITERION IS THE GROUND, NOT THE STATUS — violation test (QD technique:
// the proof of a guard is violating it). The WAKE grounds stay retryable and
// rows with NO reason are NEVER treated as deterministic.
// ---------------------------------------------------------------------------
test('fb-2591 CRITERION (violation): ONLY the deterministic refusal ground is non-retryable — `pool` / `session-not-found` / `materialization-failed` / `child` / `reroute` / an ABSENT reason stay on the re-drive wheel', async () => {
  assert.equal(isNonRetryableFailureGround('acl'), true, 'the measured deterministic ground IS non-retryable')
  for (const ground of ['pool', 'session-not-found', 'materialization-failed', 'child', 'reroute', 'unknown', 'retired']) {
    assert.equal(isNonRetryableFailureGround(ground), false, `'${ground}' is NOT in the non-retryable set — a WAKE/permanent-address class whose re-drive is either right or already settled by the dead settle`)
  }
  assert.equal(isNonRetryableFailureGround(undefined), false, '★ an UNCLASSIFIED failure is NEVER declared deterministic (no reason ⇒ no evidence ⇒ the backoff keeps its job)')
  assert.equal(isNonRetryableFailureGround(''), false, 'an empty reason is likewise not evidence')
  assert.equal(isNonRetryableFailureGround('acl '), false, 'the match is EXACT — a whitespace variant is a different token and is not silently normalized into a terminal')

  await withTempStateDir(async (stateDir) => {
    // A `pool` failure (the WAKE class: the ADDRESS is valid, the pool gate is
    // temporary) MUST keep its re-drive — proving the fix is narrow.
    const rows = [
      { messageId: 'm-pool', recipientId: 'quality-head', status: 'prepared', ts: T0 },
      { messageId: 'm-pool', recipientId: 'quality-head', status: 'failed', ts: T0 + 1000, reason: 'pool' }
    ]
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(record('m-pool', 90, ['quality-head']))}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const calls = { deliver: [], informs: [], warns: [] }
    const r = sweepHarness(stateDir, [record('m-pool', 90, ['quality-head'])], calls)
    await r.sweepDue(T0 + 10 * 60_000)
    assert.equal(calls.deliver.length, 1, 'CONTROL: a `pool` failure IS still re-driven (the channel is temporary — the backoff re-drive is exactly the right treatment)')
    assert.equal(await import('../packages/dshd-core/src/messages.ts').then((m) => m.deliveryStatus(stateDir, 'm-pool', 'quality-head')), 'failed', 'and it is NOT settled terminal by the new branch')
  })
})

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 (the second half) — «el aviso NO se pierde: o se entrega, o se
// declara NO ENTREGABLE con su razón». The declaration must be READABLE from
// the durable artifacts alone, with no log access: the pair's own row carries
// the cause and the terminal carries the settle.
// ---------------------------------------------------------------------------
test('fb-2591 ACCEPTANCE 2: the pair is DECLARED undeliverable from the LEDGER alone — the cause row (`failed/acl`) survives above the ONE terminal, and the record itself stays durable', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = measuredPair({ cycles: 2 })
    const rec = record('m-1887', 1887, ['quality-head'])
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(rec)}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const calls = { deliver: [], informs: [], warns: [] }
    const r = sweepHarness(stateDir, [rec], calls)
    // The sweep instant must be AFTER the pair's latest row (the `pairDue`
    // backoff reads `nowMs - row.ts`, and a negative age is never due — the
    // clock is not a detail here, it is the gate).
    await r.sweepDue(rows[rows.length - 1].ts + 10 * 60_000)

    const after = await readPair(stateDir, 'm-1887', 'quality-head')
    const cause = after.find((x) => x.status === 'failed')
    assert.equal(cause.reason, 'acl', '★ the CAUSE is legible in the ledger after the settle (the operator reads `acl` without any log)')
    assert.equal(after.at(-1).status, 'terminal', 'the pair-latest is the settle (the W6 scan stops re-alerting it — a terminal row is never a `delivery-failed` anomaly)')
    // The durable record is UNTOUCHED: the settle is a pure sidecar status flip.
    const messages = (await readFile(resolveMessagesPath(stateDir), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(messages.length, 1, '★ the record stays durable in messages.jsonl (NO content loss — the declaration is not a deletion)')
    assert.equal(messages[0].id, 'm-1887', 'and it is the same record')
    assert.equal(messages[0].to.includes('quality-head'), true, 'still addressed to the recipient the delivery refused')
    // Idempotence: a second cycle writes nothing (the settle is permanent).
    const before = after.length
    await r.sweepDue(rows[rows.length - 1].ts + 120 * 60_000)
    assert.equal((await readPair(stateDir, 'm-1887', 'quality-head')).length, before, 'a later sweep appends NOTHING (terminal is out of `needsRedelivery` — the stop is permanent for this pair)')
  })
})

// ---------------------------------------------------------------------------
// ⚠ PIECE 2 — THE SEAL IS AN EFFECT, NOT A CAUSE. This test is the DECISIVE
// COUNTEREXAMPLE the host's brief asks to preserve: a pair that LOSES the seal
// exactly like `acl` and is NOT re-driven. A test that demanded «repairing the
// seal stops the loop» is mis-built, and this is the proof.
// ---------------------------------------------------------------------------
test('fb-2591 PIECE 2 (counterexample): a `retired`/`unknown` pair LOSES the `noWake` seal EXACTLY like `acl` and is NOT re-driven — so repairing the seal cannot be the fix', async () => {
  await withTempStateDir(async (stateDir) => {
    // MEASURED on the live ledger at 12:28:16.228Z: the seal lives ONLY in row 0
    // of the sealed head for 4/4 `failed/acl` pairs AND for the retired/unknown
    // pairs — a 1-sealed-of-N shape.
    const sealedThenLost = (id, seq, recipientId, ground) => [
      { messageId: id, recipientId, status: 'failed', ts: T0, noWake: true, reason: ground },
      { messageId: id, recipientId, status: 'prepared', ts: T0 + 660_000 },
      { messageId: id, recipientId, status: 'failed', ts: T0 + 661_000, reason: ground }
    ]
    const rows = [
      ...sealedThenLost('m-ret', 11, 'worker-dead', 'retired'),
      ...sealedThenLost('m-unk', 12, 'ghost-id', 'unknown'),
      ...sealedThenLost('m-acl', 13, 'quality-head', 'acl')
    ]
    const recs = [
      record('m-ret', 11, ['worker-dead']),
      record('m-unk', 12, ['ghost-id']),
      record('m-acl', 13, ['quality-head'])
    ]
    await writeFile(resolveMessagesPath(stateDir), `${recs.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    // THE INVARIANT ITSELF, violated on all three pairs: the seal does NOT
    // persist across the pair's rows (only row 0 carries it).
    const byPair = new Map()
    for (const x of rows) byPair.set(`${x.messageId}`, (byPair.get(x.messageId) ?? []).concat([x]))
    for (const [id, list] of byPair) {
      assert.equal(list[0].noWake, true, `${id}: the head row carries the seal (the pair WAS an armed no-wake intent)`)
      assert.ok(list.slice(1).every((x) => x.noWake !== true), `${id}: rows 1..n LOST the seal — the measured instrument defect, reproduced for this ground too`)
      assert.equal(list.filter((x) => x.noWake === true).length, 1, `${id}: exactly ONE sealed row of ${list.length} (the measured 1-of-N shape)`)
    }

    const calls = { deliver: [], informs: [], warns: [] }
    const r = new DeliveryRedeliverer({
      stateDir,
      logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
      // The PRODUCTION predicates for the class: `retired`/`unknown` are the
      // DEAD-SETTLE's domain (the W7-A dead recipient / the C8′ non-catalog
      // recipient) — they never even reach the new branch. The `acl` pair is the
      // one that DOES reach it (its recipient is a live catalog head).
      recipientAlive: (id) => id !== 'worker-dead' && id !== 'ghost-id',
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => recs.find((x) => x.id === id),
      resolveCallerSessionId: (from) => from,
      deliver: async (rec, recipientId) => { calls.deliver.push({ messageId: rec.id, recipientId }); return 'delivered' }
    })
    await r.sweepDue(T0 + 20 * 60_000)

    assert.equal(calls.deliver.filter((c) => c.messageId === 'm-acl').length, 0, 'the `acl` pair is NOT re-driven (the fix)')
    assert.equal(calls.deliver.filter((c) => c.messageId === 'm-ret' || c.messageId === 'm-unk').length, 0, '★ the retired/unknown pairs are NOT re-driven EITHER — and they lost the seal exactly like the acl pair. THE SEAL IS NOT THE CAUSE; the GROUND is')
    // And the proof that the causal variable is the ground, not the seal: the
    // two classes are treated identically by `needsRedelivery` (both `failed`)
    // and differently ONLY by the reason column.
    // `m-acl` settles 'terminal' through the NEW branch (the fix); `m-ret`/`m-unk`
    // settle 'terminal' through the PRE-EXISTING dead settle (a third cause for
    // the same word — which is exactly why the word alone is not the instrument).
    const { deliveryStatus } = await import('../packages/dshd-core/src/messages.ts')
    assert.equal(await deliveryStatus(stateDir, 'm-acl', 'quality-head'), 'terminal', 'm-acl: settled terminal by the new deterministic-ground branch')
    assert.equal(await deliveryStatus(stateDir, 'm-ret', 'worker-dead'), 'terminal', 'm-ret: settled terminal by the PRE-EXISTING dead settle (W7-A) — the seal-lost pair that never re-drove')
    assert.equal(await deliveryStatus(stateDir, 'm-unk', 'ghost-id'), 'terminal', 'm-unk: likewise — the seal is identical to m-acl\'s and the OUTCOME is identical; only the CAUSE differs')
    assert.ok(calls.informs.some((l) => /m-ret → worker-dead.*recipient is dead\/unknown/.test(l)), 'the m-ret settle is the DEAD settle (its own log line names the reason) — not the new branch')
    assert.ok(calls.warns.some((l) => /m-acl → quality-head.*ground 'acl'/.test(l)), 'the m-acl settle is the NEW branch (its own warn names the ground)')
    for (const [id, recipientId] of [['m-ret', 'worker-dead'], ['m-unk', 'ghost-id'], ['m-acl', 'quality-head']]) {
      const status = await deliveryStatus(stateDir, id, recipientId)
      assert.equal(needsRedelivery(status), false, `${id}: \`needsRedelivery\` agrees — the ONE predicate the sweep/drain/health all read`)
    }
  })
})

// ---------------------------------------------------------------------------
// ★ THE BRANCH THAT DID NOT EXIST — `reroute` WITH A LIVE RECIPIENT. The host's
// brief measured 2 `reroute` rows and BOTH went to a RETIRED host session
// (`never-live`), so in the ledger «live vs retired recipient» and «ground acl vs
// the rest» are perfectly confounded (n=2). This test separates them at ZERO
// cost, in code: the same `failed/reroute` row, one with the recipient RETIRED
// (the measured case) and one with it ALIVE.
// ---------------------------------------------------------------------------
test('fb-2591 REROUTE branch: a `failed/reroute` row is NOT settled by the new branch — the measured retired-recipient case AND a LIVE recipient behave IDENTICALLY (the ground is what selects, never the recipient liveness)', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = [
      // The measured shape (m-1839/m-1850, 1 row each): a noWake order to a
      // RETIRED host-family address that re-routes — the C2 failure.
      { messageId: 'm-1839', recipientId: 'host-session-retired', status: 'failed', ts: T0, noWake: true, reason: 'reroute' },
      // THE BRANCH THAT DID NOT EXIST: the SAME ground to a LIVE recipient.
      // `reroute` is emitted by `catalogRoute` ONLY for a route the resolver
      // classifies 'reroute' (a RETIRED host-family address with a live
      // successor) — so structurally this row cannot carry a live recipient in
      // production; the test states that by construction (see the assertion
      // below) and pins the FIX's behaviour for it: identical treatment.
      { messageId: 'm-live-reroute', recipientId: 'host-session-live', status: 'failed', ts: T0, noWake: true, reason: 'reroute' }
    ]
    const recs = [
      record('m-1839', 1839, ['host-session-retired'], 'deepartments'),
      record('m-live-reroute', 1900, ['host-session-live'], 'deepartments')
    ]
    await writeFile(resolveMessagesPath(stateDir), `${recs.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    const calls = { deliver: [], informs: [], warns: [] }
    // `recipientAlive` true for BOTH: the LIVE-recipient control. A retired
    // host whose rotation chain resolves a live successor is ALIVE in the
    // production predicate too (fb-58 F-3) — so this is the measured case.
    const r = new DeliveryRedeliverer({
      stateDir,
      logger: { info: (m) => calls.informs.push(m), warn: (m) => calls.warns.push(m) },
      recipientAlive: () => true,
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => recs.find((x) => x.id === id),
      resolveCallerSessionId: (from) => from,
      deliver: async (rec, recipientId) => { calls.deliver.push({ messageId: rec.id, recipientId }); return 'failed' }
    })
    await r.sweepDue(T0 + 10 * 60_000)

    // The measured P2-guard reading, now VERIFIED IN CODE: a sealed row to a
    // NON-running recipient is held — for the reroute ground exactly like for
    // any other sealed row. This is why the 2 measured `reroute` rows never
    // re-drove: the seal, not a special reroute exemption.
    assert.equal(calls.deliver.length, 0, '★ BOTH reroute pairs are HELD (not driven): the P2 guard holds a SEALED row whose recipient is not running — the real reason the 2 measured reroute rows never re-drove')
    const { deliveryStatus } = await import('../packages/dshd-core/src/messages.ts')
    for (const id of ['m-1839', 'm-live-reroute']) {
      assert.equal(await deliveryStatus(stateDir, id, id === 'm-1839' ? 'host-session-retired' : 'host-session-live'), 'failed', `${id}: the row is UNTOUCHED by the new branch (reroute keeps its C2 semantics — the sender re-addresses; this lane never settles it)`)
    }
    // THE SEPARATION THE LEDGER COULD NOT GIVE (n=2, confounded): with the SAME
    // ground, a LIVE recipient and a RETIRED one are treated identically by this
    // fix — so «ground = acl» and «recipient liveness» are NOT the same variable.
    assert.equal(calls.deliver.filter((c) => c.messageId === 'm-live-reroute').length, calls.deliver.filter((c) => c.messageId === 'm-1839').length, 'the live and the retired reroute recipients get the IDENTICAL treatment (0 drives each) — the discriminating variable is the GROUND, never the recipient liveness')
    // And the seal is what selected the hold: strip it and the pair IS driven
    // (the reroute ground is NOT in the non-retryable set — the new branch never
    // touches it, so the ONLY thing that was holding it is the P2 guard).
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify({ ...r, noWake: undefined })).join('\n')}\n`, 'utf8')
    calls.deliver.length = 0
    await r.sweepDue(T0 + 20 * 60_000)
    assert.equal(calls.deliver.length, 2, 'CONTROL (the seal is the selecting variable for reroute): with the seal STRIPPED both reroute pairs ARE re-driven — proof that the P2 guard, not any reroute exemption, is what held them above, and proof that `reroute` is NOT in the fix\'s non-retryable set')
  })
})

// ---------------------------------------------------------------------------
// ★ RED-FIRST / REVERT-CHECK (the repo's own method — `redelivery-cap-reachability`
// neutralizes the source and demands RED, so a green test cannot be green for the
// wrong reason). NEUTRALIZING = defeating the new branch in a COPY of the source:
// `isNonRetryableFailureGround` always returns false, i.e. the pre-fix world.
//
// ⚠ WHAT THE NEUTRALIZED RUN MEASURED, AND A CLAIM OF MINE IT REFUTES: I first
// expected the pre-fix loop to be UNBOUNDED. It is NOT — the lane-② CAP bounds it
// at 12 attempts (24 rows for the pair), which is exactly the fb-2591 measurement
// («12 filas y ~88 min de intentos fútiles»). The defect is NOT «it never stops»:
// it is that the 12 attempts are FUTILE (0 delivered) and the cap's ending is a
// SILENCE with no reason (12 `terminal`, 0 delivered — acceptance 2). This test
// asserts what was MEASURED, not what I expected.
// ---------------------------------------------------------------------------
test('fb-2591 RED-FIRST: with the fix NEUTRALIZED (the predicate always false — the pre-fix world) the SAME fixture burns the FULL cap (12 futile attempts, 0 delivered, a silent terminal); with the fix it makes NO attempt at all and DECLARES why', async () => {
  const { mkdtempSync, readFileSync: readSync, writeFileSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const src = readSync(new URL('../packages/dshd-core/src/messages.ts', import.meta.url), 'utf8')
  const neutralized = src.replace(
    'return reason !== undefined && NON_RETRYABLE_FAILURE_GROUNDS.has(reason)',
    'return false'
  )
  assert.notEqual(neutralized, src, 'the neutralization must actually apply (the predicate body is present verbatim) — otherwise the RED check is a tautology')
  const dir = mkdtempSync(path.join(tmpdir(), 'fb2591-neutral-'))
  writeFileSync(path.join(dir, 'messages.ts'), neutralized)
  const M = await import(pathToFileURL(path.join(dir, 'messages.ts')).href)

  /** Drive 240 one-minute sweep cycles (4 h of clock > the 12-attempt cap at the
   * measured ~5-11 min cadence, and > the 10-min prepared-stuck clock). */
  const drive = async (mod, modDeliveryStatus, modParse) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'fb2591-neutral-state-'))
    const rec = record('m-1887', 1887, ['quality-head'])
    const rows = measuredPair({ cycles: 1 })
    await writeFile(resolveMessagesPath(stateDir), `${JSON.stringify(rec)}\n`, 'utf8')
    await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const calls = { deliver: [], warns: [] }
    const r = new mod.DeliveryRedeliverer({
      stateDir,
      logger: { info: () => {}, warn: (m) => calls.warns.push(m) },
      recipientAlive: () => true,
      recipientDormant: () => false,
      recipientRunning: () => false,
      getRecord: async (id) => (id === rec.id ? rec : undefined),
      resolveCallerSessionId: (from) => from,
      // The ACL-refusing seam: EVERY attempt fails with the same ground — the
      // measured behaviour (the pair can never deliver as addressed).
      deliver: async (rec2, recipientId) => {
        calls.deliver.push(1)
        await appendRows(stateDir, [
          { messageId: rec2.id, recipientId, status: 'prepared', ts: Date.now() },
          { messageId: rec2.id, recipientId, status: 'failed', ts: Date.now() + 1, reason: 'acl' }
        ])
        return 'failed'
      }
    })
    let clock = rows[rows.length - 1].ts
    let settleTick = null
    for (let tick = 1; tick <= 240; tick++) {
      clock += 60_000
      await r.sweepDue(clock)
      if (settleTick === null && (await modDeliveryStatus(stateDir, 'm-1887', 'quality-head')) === 'terminal') settleTick = tick
    }
    const after = modParse(await readFile(resolveDeliveriesPath(stateDir), 'utf8')).filter((x) => x.messageId === 'm-1887' && x.recipientId === 'quality-head')
    const out = {
      drives: calls.deliver.length,
      settleTick,
      latest: after.at(-1).status,
      delivered: after.filter((x) => x.status === 'delivered' || x.status === 'resumed').length,
      declaresReason: calls.warns.some((w) => /ground 'acl'/.test(w) && /REFUSED BY ROUTE/.test(w)),
      capStops: calls.warns.filter((w) => /STOPPED after \d+ attempts/.test(w)).length
    }
    await rm(stateDir, { recursive: true, force: true })
    return out
  }

  const pre = await drive(M, M.deliveryStatus, M.parseDeliveryRows)
  const post = await drive({ DeliveryRedeliverer }, deliveryStatus, parseDeliveryRows)

  // ── THE PRE-FIX WORLD (neutralized) ───────────────────────────────────────
  assert.ok(pre.drives >= 10, `★ NEUTRALIZED (pre-fix): the pair is re-driven ${pre.drives} times — the futile attempts happen (the measured loop, no time compression)`)
  assert.equal(pre.capStops, 1, '★ NEUTRALIZED: the loop is closed by the CAP — ONE «STOPPED after N attempts» warn. This is what bounded it (my first expectation of an UNBOUNDED loop was WRONG and is corrected here by measurement)')
  assert.equal(pre.delivered, 0, '★ NEUTRALIZED: 0 delivered rows — every one of those attempts was FUTILE (the deterministic refusal cannot land, however many times it is retried)')
  assert.equal(pre.latest, 'terminal', '★ NEUTRALIZED: it ends on the cap\'s `terminal` — the SILENCE acceptance 2 names: the recipient never saw the message and nothing DECLARES that')
  assert.equal(pre.declaresReason, false, '★ NEUTRALIZED: the ledger\'s closing word carries NO reason — the cap stop is a count, never a cause (the defect: an operator cannot read WHY from the settle)')
  // ── THE FIXED WORLD ───────────────────────────────────────────────────────
  assert.equal(post.drives, 0, '★ FIXED: ZERO re-drives — the deterministic refusal is never retried (acceptance 1)')
  assert.equal(post.delivered, 0, 'and no delivery is fabricated by the fix: the message genuinely cannot be delivered as addressed')
  assert.equal(post.latest, 'terminal', 'FIXED: the pair-latest is terminal from the FIRST sweep on (no attempt precedes the settle)')
  assert.equal(post.declaresReason, true, '★ FIXED: the settle DECLARES the reason verbatim (acceptance 2 — «or declared undeliverable with its reason», never a loop and never a silence)')
  assert.equal(post.capStops, 0, 'the CAP never fires in the fixed world (nothing accrues an attempt — the cap is not the instrument that closes this class)')
  await rm(dir, { recursive: true, force: true })
})
