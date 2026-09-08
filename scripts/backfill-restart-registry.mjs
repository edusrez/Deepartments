#!/usr/bin/env node
/**
 * backfill-restart-registry.mjs — fb-43 §7 (VALLE 09-07) ONE-SHOT attribution
 * backfill for the restart-registry.
 *
 * PURPOSE (record fb-43 — ATRIBUCIÓN DE RESTARTS §7, design
 * reports/explore-deep/2026-09-07-fb43-attribution-design-4b3a89e3.md):
 *   The runtime registry is append-only: every historical row was appended with
 *   cause='unknown' (0% post-seed attribution — the mechanical gap QI-48). The
 *   §7 ledger closure fixed the causes in DOCS; this one-shot materializes them
 *   in the FILE (backward-compatible: the row format {bootId, ts, cause} and the
 *   header comment stay byte-identical except the attributed causes).
 *
 *   HOST-RUN VEHICLE: the worker never touches live state. The HOST runs this
 *   script against the live stateDir in the VALLE window:
 *     node scripts/backfill-restart-registry.mjs <stateDir>            # dry-run
 *     node scripts/backfill-restart-registry.mjs <stateDir> --apply    # write
 *   (default = --dry-run — prints the row-by-row plan and touches NOTHING).
 *
 * WRITE SEMANTICS (Mode 1 of the design — atomic rewrite):
 *   - ONLY the rows whose bootId is in the SANCTIONED map are touched (their
 *     `cause` field is replaced; bootId/ts are byte-identical).
 *   - The 4 SEED rows and every other row keep their EXACT original bytes
 *     (the file is rewritten line-by-line, untouched lines copied verbatim).
 *   - A row whose cause is ALREADY set and DIFFERS from the map → LOUD ABORT
 *     (never a silent overwrite); a map bootId with no matching row → LOUD
 *     ABORT (ledger renumbering detection); a duplicate map bootId → LOUD
 *     ABORT (fila repetida — the ledger never renumbers).
 *   - ATOMIC write: tmp file in the same dir + rename. ANTI-RACE guard: the
 *     LAST data line at write time must be byte-identical to the last data
 *     line at THIS run's start — a concurrent daemon append in between ABORTS
 *     (never clobber; re-run in the next window; the host re-runs dry-run
 *     first).
 *   - The runtime contract (seed-once + append-onwards) is untouched: this
 *     script is maintenance one-off, never a runtime path.
 *
 * FIXTURE REGENERATION (test/invoke.test.js — the embedded snapshot):
 *   The fb-43 §7 test embeds a COPY of the live file (46 rows, snapshot
 *   2026-09-07 12:33Z). To regenerate AFTER the file grew: copy
 *   <stateDir>/restart-registry.jsonl verbatim into the FB43_REGISTRY_FIXTURE
 *   constant and update the row-count assertions (read-only procedure — the
 *   live file is never written by the tests).
 *
 * EXIT: 0 = ran (dry-run or apply or nothing-to-do); 1 = usage error / ABORT.
 * The plan is printed on stdout; an abort message on stderr.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** fb-43 §7 — the SANCTIONED bootId → cause map (ledger QI-48 §1/§2, wording
 * fijado por TI del ledger; the 4 seeds are already attributed — no-op). The
 * 10 entries below are the ONLY rows this backfill ever touches. */
export const SANCTIONED_ATTRIBUTIONS = [
  // SALTO 11:14 (crash-loop cierre) — SANCIONADO (402)
  { bootId: "28c3a44e-1ebb-4ca0-875e-714ed4aba7db", cause: "SALTO 11:14 (crash-loop cierre)" },
  // churn-429 (pooler) — artefacto429 CONFIRMADO (par 2 min, rotación pooler oc-6→oc-13)
  { bootId: "32df6bad-08ff-4507-8b1b-9ed8c91e9003", cause: "churn-429 (pooler)" },
  { bootId: "406faf93-8d5a-4c77-b42d-719be5d2a2cd", cause: "churn-429 (pooler)" },
  // canary-1 — SANCIONADO (402)
  { bootId: "924c9a24-8464-4034-9df5-f86b33981e03", cause: "canary-1" },
  // agrupado 15:39 — SANCIONADO (402)
  { bootId: "cbe5c0b7-02b2-451d-b414-269361bc7b24", cause: "agrupado 15:39" },
  // canary-3 (smart_restart wake-28) — SANCIONADO
  { bootId: "146d1d07-7cef-4447-8ca4-ca86f15300e6", cause: "canary-3 (smart_restart wake-28)" },
  // ignition org.offlineReap — SANCIONADO (7º pre-decisión)
  { bootId: "4468ca24-cde6-48d1-a290-ccb7dacd6a7f", cause: "ignition org.offlineReap" },
  // canary key_14 (P1-op) — SANCIONADO #12
  { bootId: "d2fc05b6-d22b-4070-8da3-a94e7063bbdd", cause: "canary key_14 (P1-op)" },
  // deploy fb-168 (pooler P-POOL) — SANCIONADO #13
  { bootId: "c0843e91-29c8-424c-94b5-3401dbcb20d9", cause: "deploy fb-168 (pooler P-POOL)" },
  // ceremonia restart canary:true (commit 562d994) — boot actual a la estampa QI-48
  { bootId: "977683e7-ed06-45d0-98b3-4f65a72ccecf", cause: "restart canary:true del cierre (commit 562d994)" }
];

/** Parse the registry text → { headerLines, rows } (the READER semantics of the
 * lib: non-JSON lines are the header/comments; a row without a string bootId /
 * finite numeric ts is dropped; a non-string cause defaults to 'unknown'). */
export function parseRegistryFile(text) {
  const headerLines = [];
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      headerLines.push(line); // header comment / malformed line — never a row
      continue;
    }
    if (typeof parsed.bootId !== "string" || typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      headerLines.push(line);
      continue;
    }
    rows.push({ bootId: parsed.bootId, ts: parsed.ts, cause: typeof parsed.cause === "string" ? parsed.cause : "unknown" });
  }
  return { headerLines, rows };
}

/** Verify the map against the file rows — the THREE loud discriminators (a
 * violation never proceeds to a write):
 *   1. a DUPLICATE map bootId (fila repetida — the ledger never renumbers);
 *   2. a map bootId with NO matching row (boot desconocido — ledger
 *      re-numbering would make the map stale; name the bootId);
 *   3. a row whose cause is ALREADY SET and differs from the map (cause ya
 *      presente — never a silent overwrite).
 * Throws with a clear message; returns the map on success (chainable). */
export function verifyMap(map, rows) {
  const seen = new Set();
  for (const entry of map) {
    if (seen.has(entry.bootId)) {
      throw new Error(`fb-43 backfill ABORT — fila repetida: the map lists bootId '${entry.bootId}' TWICE (the ledger never renumbers; remove the duplicate entry)`);
    }
    seen.add(entry.bootId);
    const row = rows.find((r) => r.bootId === entry.bootId);
    if (row === undefined) {
      throw new Error(`fb-43 backfill ABORT — boot desconocido: map bootId '${entry.bootId}' has NO matching registry row (ledger re-numbering? regenerate the map/fixture read-only and re-verify)`);
    }
    if (row.cause !== "unknown" && row.cause !== entry.cause) {
      throw new Error(`fb-43 backfill ABORT — cause ya presente: row '${entry.bootId}' is already attributed '${row.cause}' ≠ map '${entry.cause}' (never a silent overwrite; reconcile the ledger first)`);
    }
  }
  return map;
}

/** Apply the map over the parsed rows → the ATTRIBUTED row list (pure — the
 * same row order, only the mapped causes replaced). Runs verifyMap first (the
 * loud discriminators) so no caller can bypass the never-silent-overwrite
 * guard. */
export function applyAttribution(rows, map) {
  verifyMap(map, rows);
  const byId = new Map(map.map((e) => [e.bootId, e.cause]));
  return rows.map((row) => (byId.has(row.bootId) ? { ...row, cause: byId.get(row.bootId) } : row));
}

/** Build the row-by-row plan (unchanged lines keep their ORIGINAL bytes — the
 * seed rows are never touched). */
export function planBackfill(rows, map) {
  const byId = new Map(map.map((e) => [e.bootId, e.cause]));
  const changes = [];
  let noop = 0;
  for (const row of rows) {
    const cause = byId.get(row.bootId);
    if (cause === undefined) continue; // not in the map → untouched
    if (row.cause === cause) noop += 1; // already attributed identically → no-op
    else changes.push({ bootId: row.bootId, from: row.cause, to: cause, ts: row.ts });
  }
  return { changes, noop, total: rows.length };
}

/** Pure rewrite of the FULL file text: header/comment lines + untouched rows
 * copied VERBATIM; only the mapped rows re-serialized with the attributed
 * cause (same {bootId, ts, cause} shape). Throws (verify) before producing
 * anything. */
export function rewriteRegistryText(text, map) {
  const { headerLines, rows } = parseRegistryFile(text);
  verifyMap(map, rows);
  const byId = new Map(map.map((e) => [e.bootId, e.cause]));
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (typeof parsed.bootId !== "string" || typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      out.push(line);
      continue;
    }
    const cause = byId.get(parsed.bootId);
    if (cause === undefined || cause === parsed.cause) {
      out.push(line); // untouched — byte-identical (incl. the 4 seeds)
    } else {
      out.push(JSON.stringify({ bootId: parsed.bootId, ts: parsed.ts, cause }));
    }
  }
  return out.join("\n") + "\n";
}

/** The anti-race-last-line fingerprint: the LAST data line (byte-identical
 * comparison — a concurrent append changes it). */
function lastDataLine(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

/** CLI entry (guarded main — the module is importable by tests). */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const stateDirArg = args.find((a) => a !== "--apply" && a !== "--dry-run");
  if (!stateDirArg) {
    console.error("usage: node scripts/backfill-restart-registry.mjs <stateDir> [--dry-run|--apply]");
    process.exit(1);
  }
  const filePath = join(stateDirArg, "restart-registry.jsonl");
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`fb-43 backfill ABORT — cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const { rows } = parseRegistryFile(text);
  try {
    verifyMap(SANCTIONED_ATTRIBUTIONS, rows);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const plan = planBackfill(rows, SANCTIONED_ATTRIBUTIONS);
  console.log(`fb-43 §7 restart-registry backfill — ${filePath}`);
  console.log(`  total rows: ${plan.total} — map entries: ${SANCTIONED_ATTRIBUTIONS.length}`);
  for (const c of plan.changes) {
    console.log(`  L${rows.findIndex((r) => r.bootId === c.bootId) + 1} boot=${c.bootId.slice(0, 8)} cause '${c.from}' → '${c.to}'`);
  }
  console.log(`  already-attributed no-ops: ${plan.noop} — remaining 'unknown' (deliberately un-attributed): ${plan.total - plan.changes.length - plan.noop}`);
  if (!apply) {
    console.log("DRY-RUN — nothing written. Re-run with --apply to materialize.");
    process.exit(0);
  }
  // APPLY: atomic tmp+rename with the anti-race last-line guard.
  const before = lastDataLine(text);
  if (plan.changes.length === 0) {
    console.log("APPLY — nothing to do (every mapped row already attributed).");
    process.exit(0);
  }
  const newText = rewriteRegistryText(text, SANCTIONED_ATTRIBUTIONS);
  const tmpPath = `${filePath}.fb43-bf.tmp`;
  writeFileSync(tmpPath, newText, "utf8");
  let liveText;
  try {
    liveText = readFileSync(filePath, "utf8");
  } catch (error) {
    unlinkSync(tmpPath);
    console.error(`fb-43 backfill ABORT — the file vanished during the run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (lastDataLine(liveText) !== before) {
    unlinkSync(tmpPath);
    console.error("fb-43 backfill ABORT — anti-race guard: the registry's LAST row changed during the run (a concurrent daemon boot append). Nothing was written; re-run in the next window (dry-run first).");
    process.exit(1);
  }
  renameSync(tmpPath, filePath);
  console.log(`APPLY — wrote ${plan.changes.length} attributed row(s) atomically (${plan.changes.length}/${plan.total} rows attributed; seeds untouched).`);
}