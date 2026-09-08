#!/usr/bin/env node
/**
 * mark-delivery-cli.mjs — FB-253: HOST-RUN delivery hygiene CLI for STALE
 * 'prepared'/'failed' write-ahead sidecar rows whose recipient is a RETIRED
 * post (append-only 'terminal' settle).
 *
 * PURPOSE (record QD m-3271, backlog fb-253; the stuck-class fb-117/137):
 *   `markDelivery` lives only in the dshd-core lib. The in-session settle
 *   (tools.ts settleRetiredPostDeliveries) terminalizes a retiring post's
 *   pending rows AT RETIRE TIME and the boot re-delivery driver
 *   (DeliveryRedeliverer.run) re-settles at boot — but a crash, a restart, or
 *   a retire driven by job/machinery can leave 'prepared' rows PARKED against
 *   a recipient that is ALREADY RETIRED in the catalog, with neither pass
 *   having run. This CLI is the host-run COMPLEMENT (post-hoc hygiene):
 *   the operator runs it against a stateDir to LIST and APPLY the SAME
 *   terminal settle the code paths above implement — so future hygiene never
 *   needs an ad-hoc script.
 *
 * CRITERION (EXACTLY settleRetiredPostDeliveries — the settle and the boot
 *   driver share latestPerKey dedupe + needsRedelivery + markDelivery):
 *   a (messageId, recipientId) pair is a candidate iff
 *     1. its LATEST delivery row (the last row for the pair wins — a later
 *        'delivered'/'resumed'/'self'/'terminal' shadows an earlier row)
 *        `needsRedelivery` ('prepared' | 'failed');
 *     2. the recipient is a RETIRED post in `<stateDir>/posts.json`
 *        (registry.ts PostEntryPersisted — `retired: true` is the exact flag
 *        markPostRetired writes; posts.json maps postId → entry);
 *     3. the ALTO-1 rebind guard passes: the CURRENT messages.jsonl record
 *        for the message EXISTS and its `to` includes the recipient (a stale
 *        sidecar row whose record was trimmed, or rebound to a DIFFERENT
 *        recipient, is NEVER settled — the guard is non-negotiable).
 *   APPLY appends ONE 'terminal' row per candidate via markDelivery —
 *   APPEND-ONLY (never rewrites or removes previous rows, never re-marks
 *   'prepared'), exactly like the settle/boot passes.
 *
 * HOST USAGE (run from the repo root; 'dshd-core' resolves via node_modules;
 *   the package must be built — `pnpm build` — like every repo consumer):
 *     node scripts/mark-delivery-cli.mjs --list --stateDir <dir>
 *         DRY probe (DEFAULT mode) — print the candidate pairs, write nothing.
 *     node scripts/mark-delivery-cli.mjs --apply --dry-run --stateDir <dir>
 *         compute + print the plan, write NOTHING.
 *     node scripts/mark-delivery-cli.mjs --apply --stateDir <dir>
 *         append ONE 'terminal' row per candidate pair.
 *     node scripts/mark-delivery-cli.mjs --list|--apply --recipient <id> --stateDir <dir>
 *         restrict the scan to ONE recipient id (a non-retired scope yields 0
 *         — a LIVE recipient is never touched, even when scoped).
 *   --stateDir is REQUIRED — NEVER defaulted: a wrong tree must fail loud
 *   (missing posts.json aborts), never produce a silent 0-candidate run.
 *   Live store example: --stateDir /.deepartments.
 *   IDEMPOTENT: a second run after an apply lists 0 candidates (the appended
 *   'terminal' row shadows the stale 'prepared'/'failed').
 *
 * EXIT: 0 = ran (list / apply / dry-run / nothing-to-do); 1 = usage error or
 *   loud abort (a corrupt or missing store file — NOTHING is ever written on
 *   abort). Plan/result lines go to stdout; errors to stderr.
 *
 * TESTABILITY: the pure helpers (parseRetiredPostsText / selectSettleCandidates
 *   / readDeliveryRows / readRecordsById) are exported and unit-tested in
 *   test/mark-delivery-cli.test.js against mkdtemp fixtures; the guarded main
 *   below runs only when the script is executed directly (the backfill
 *   pattern — importing the module from a test never runs the CLI).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  markDelivery,
  needsRedelivery,
  parseDeliveryRows,
  parseMessageRecords,
  resolveDeliveriesPath,
  resolveMessagesPath
} from 'dshd-core'

/**
 * Parse the posts-registry TEXT (`<stateDir>/posts.json`) into the RETIRED
 * post-id set. Shape (registry.ts — PostEntryPersisted keyed by postId): a
 * JSON object `{ [postId]: { sessionId, agentPreset, ..., retired?: true } }`;
 * a post is retired exactly when its entry carries `retired: true` (the flag
 * markPostRetired writes). THROWS loud on a malformed/non-object registry: an
 * operator tool must never silently conclude "no retired posts" on a corrupt
 * or wrong store.
 */
export function parseRetiredPostsText(text, label = 'posts.json') {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`mark-delivery ABORT — ${label} malformed (${error instanceof Error ? error.message : String(error)}): the RETIRED set is undeterminable; nothing was written`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mark-delivery ABORT — ${label} is not a posts-registry object: the RETIRED set is undeterminable; nothing was written`)
  }
  const retired = new Set()
  for (const [postId, entry] of Object.entries(parsed)) {
    if (entry !== null && typeof entry === 'object' && entry.retired === true) retired.add(postId)
  }
  return retired
}

/** Read the RETIRED post-id set from `<stateDir>/posts.json` — the stateDir
 * canary: a MISSING posts.json aborts loud (a wrong --stateDir fails HERE,
 * never as a silent 0-candidate hygiene run). */
export function readRetiredPostIds(stateDir) {
  const filePath = path.join(stateDir, 'posts.json')
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`mark-delivery ABORT — ${filePath} missing: cannot determine the RETIRED set (wrong --stateDir?); nothing was written`)
    }
    throw new Error(`mark-delivery ABORT — cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}; nothing was written`)
  }
  return parseRetiredPostsText(text, filePath)
}

/**
 * Read + parse the delivery sidecar rows of one stateDir (`deliveries.jsonl`).
 * A MISSING file → [] (nothing ever sent — a legitimate no-op, exit 0). A
 * malformed NON-trailing row (parseDeliveryRows throws) ABORTS loud: data
 * corruption must never produce a false 0-candidate hygiene run.
 */
export function readDeliveryRows(stateDir) {
  const filePath = resolveDeliveriesPath(stateDir)
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw new Error(`mark-delivery ABORT — cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}; nothing was written`)
  }
  try {
    return parseDeliveryRows(text, filePath)
  } catch (error) {
    throw new Error(`mark-delivery ABORT — ${error instanceof Error ? error.message : String(error)}; nothing was written`)
  }
}

/** Read the CURRENT message-record map (id → record) for the ALTO-1 rebind
 * guard. LOUD abort on a missing/malformed messages.jsonl: the guard is
 * non-negotiable — without the current records NOTHING settles (the settle's
 * own rule: the sidecar is only truth alongside the records, never alone). */
export function readRecordsById(stateDir) {
  const filePath = resolveMessagesPath(stateDir)
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`mark-delivery ABORT — cannot read ${filePath} (${error instanceof Error ? error.message : String(error)}): the ALTO-1 record guard is unavailable; nothing was written`)
  }
  let records
  try {
    records = parseMessageRecords(text, filePath)
  } catch (error) {
    throw new Error(`mark-delivery ABORT — ${error instanceof Error ? error.message : String(error)}; nothing was written`)
  }
  return new Map(records.map((record) => [record.id, record]))
}

/**
 * PURE candidate selection — the EXACT settle criterion shared with the
 * in-session settle (tools.ts settleRetiredPostDeliveries) and the boot
 * driver (DeliveryRedeliverer.run):
 *   1. latestPerKey dedupe — the LATEST row per (messageId, recipientId) wins
 *      (a later delivered/resumed/self/terminal row shadows an earlier
 *      'prepared'/'failed'; one PAIR is evaluated, never one row);
 *   2. the latest status `needsRedelivery` ('prepared' | 'failed');
 *   3. the recipient is in the RETIRED post-id set;
 *   4. ALTO-1 rebind guard — the CURRENT record for the message EXISTS and its
 *      `to` includes the recipient (a trimmed/rebound stale row is skipped).
 * Optional `recipientScope` narrows to ONE recipient id; a non-retired scope
 * can only yield 0 — a LIVE recipient is never touched, even when scoped.
 * Returns the candidate pairs deterministically sorted (messageId, then
 * recipientId) for stable output/apply order. Pure — no I/O, no writes.
 */
export function selectSettleCandidates(rows, recordsById, retiredPostIds, recipientScope = undefined) {
  const latestPerKey = new Map()
  for (const row of rows) latestPerKey.set(`${row.messageId}\u0000${row.recipientId}`, row)
  const candidates = []
  for (const row of latestPerKey.values()) {
    if (recipientScope !== undefined && row.recipientId !== recipientScope) continue
    if (!retiredPostIds.has(row.recipientId)) continue
    if (!needsRedelivery(row.status)) continue
    const record = recordsById.get(row.messageId)
    if (record === undefined || !record.to.includes(row.recipientId)) continue
    candidates.push({ messageId: row.messageId, recipientId: row.recipientId, status: row.status, ts: row.ts })
  }
  candidates.sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : a.recipientId < b.recipientId ? -1 : a.recipientId > b.recipientId ? 1 : 0))
  return candidates
}

/** Usage-class error (prints usage on the CLI; NOT a store abort). */
export class MarkDeliveryUsageError extends Error {}

/** The usage text (host documentation in one place). */
export function usageLines() {
  return [
    'usage: node scripts/mark-delivery-cli.mjs --list|--apply [--recipient <id>] [--dry-run] --stateDir <path>',
    '  --list            (default) DRY probe — print the candidate pairs, write nothing',
    '  --apply           append ONE \'terminal\' row per candidate pair via markDelivery (append-only)',
    '  --dry-run         with --apply: compute + print the plan, write NOTHING',
    '  --recipient <id>  restrict the scan to ONE recipient id (a non-retired scope yields 0)',
    '  --stateDir <path> REQUIRED — the stateDir to scan (never defaulted: a wrong tree must fail loud)'
  ]
}

/** The CLI body (exported for integration tests): argv → { code, out }. */
export async function main(argv) {
  const out = []
  let mode = null
  let dryRun = false
  let recipient
  let stateDir
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') {
      if (mode === 'apply') throw new MarkDeliveryUsageError('give exactly ONE of --list|--apply')
      mode = 'list'
    } else if (arg === '--apply') {
      if (mode === 'list') throw new MarkDeliveryUsageError('give exactly ONE of --list|--apply')
      mode = 'apply'
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--recipient') {
      recipient = argv[++i]
      if (recipient === undefined) throw new MarkDeliveryUsageError('--recipient requires a value')
    } else if (arg === '--stateDir') {
      stateDir = argv[++i]
      if (stateDir === undefined) throw new MarkDeliveryUsageError('--stateDir requires a value')
    } else {
      throw new MarkDeliveryUsageError(`unknown argument: ${arg}`)
    }
  }
  if (stateDir === undefined) throw new MarkDeliveryUsageError('--stateDir is REQUIRED (never defaulted)')
  const isApply = mode === 'apply'

  // Reads are LOUD on a corrupt/wrong store; on any abort NOTHING was written.
  const retired = readRetiredPostIds(stateDir)
  const rows = readDeliveryRows(stateDir)
  const recordsById = readRecordsById(stateDir)
  const candidates = selectSettleCandidates(rows, recordsById, retired, recipient)

  const modeLabel = isApply ? (dryRun ? 'APPLY (dry-run — nothing written)' : 'APPLY') : 'LIST (dry probe, nothing written)'
  out.push(`fb-253 mark-delivery — ${modeLabel}`)
  out.push(`  stateDir: ${stateDir}`)
  out.push(`  retired recipients in posts.json: ${retired.size}${recipient !== undefined ? ` (scoped to --recipient ${recipient})` : ''}`)
  out.push(`  candidate pairs (latest needsRedelivery → retired recipient → record guard OK): ${candidates.length}`)
  for (const c of candidates) out.push(`    ${c.messageId} → ${c.recipientId}  (was ${c.status})`)
  if (candidates.length === 0) {
    out.push('  nothing to settle.')
  } else if (!isApply || dryRun) {
    out.push(`  ${dryRun ? 'DRY-RUN' : 'LIST'} — nothing written (re-run with --apply${dryRun ? ' without --dry-run' : ''} to append ONE 'terminal' row per candidate).`)
  } else {
    for (const c of candidates) {
      // APPEND-ONLY: markDelivery appends exactly one row — previous rows are
      // never rewritten or removed, and the pair is never re-marked 'prepared'.
      const row = await markDelivery(stateDir, c.messageId, c.recipientId, 'terminal')
      out.push(`    → appended 'terminal' ${JSON.stringify(row)}`)
    }
    out.push(`  applied ${candidates.length} terminal row(s) via markDelivery (append-only — previous rows untouched). Idempotent: a re-run now lists 0 candidates.`)
  }
  return { code: 0, out }
}

// Guarded main (the backfill pattern): the module is importable by tests —
// the CLI runs ONLY when executed directly (process.argv[1] === this file).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code, out } = await main(process.argv.slice(2))
    for (const line of out) console.log(line)
    process.exitCode = code
  } catch (error) {
    if (error instanceof MarkDeliveryUsageError) {
      console.error(`mark-delivery ${error.message}`)
      for (const line of usageLines()) console.error(line)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  }
}