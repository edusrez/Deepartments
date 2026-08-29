/**
 * mirror-client.mjs
 *
 * D5 (modularization, 2026-08-29) — the client build FOLD: packages/dshd-gui
 * is the SINGLE build/normalize source of the `deepartments-client` surface
 * (its tsdown.config.ts + scripts/normalize-client-banner.mjs produce
 * packages/dshd-gui/client/client.js from src/client/index.tsx). The root
 * `./client` of the bundle is PRESERVED as a byte-identical MIRROR (R6):
 * the deployed artifact served at /plugins/dsh-deepartments/client.js and
 * declared by exports "./client" + the `dsh.client` inject metadata — the
 * BUNDLE row only. CLIENT-ROW RULE (fix 2026-08-29): a client graph row is
 * keyed by the loader ENTRY name and this bundle registers
 * "dsh-deepartments", so dshd-gui (entry name "dshd-gui") must NOT declare
 * `dsh.client` — a row by that name could never be satisfied (GUI boot
 * FAIL). dshd-gui stays the build owner; dsh-deepartments keeps the row.
 *
 * This script copies the package-built client/client.js onto the root
 * client/client.js and verifies the mirror is byte-identical (a copy is
 * byte-identical by construction; the verification guards against a missing
 * or empty source, i.e. a build:client that was skipped).
 *
 * Usage: pnpm build:client  (root) = pnpm --filter dshd-gui run build:client
 *                                  && node scripts/mirror-client.mjs
 * The root tsdown.config.ts + scripts/normalize-client-banner.mjs copies were
 * REMOVED in the fold — the package owns the pipeline; this script is the
 * mirror seam. Nothing else references the root copies.
 */
import { copyFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "packages", "dshd-gui", "client", "client.js");
const DEST_DIR = join(ROOT, "client");
const DEST = join(DEST_DIR, "client.js");

if (!existsSync(SOURCE)) {
  console.error(`[mirror-client] source missing: ${SOURCE} — run the dshd-gui build first (pnpm --filter dshd-gui run build:client)`);
  process.exit(1);
}
const sourceBytes = statSync(SOURCE).size;
if (sourceBytes === 0) {
  console.error(`[mirror-client] source is EMPTY: ${SOURCE} — the dshd-gui build produced no bytes (aborting, no mirror overwrite)`);
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SOURCE, DEST);
const destBytes = statSync(DEST).size;
if (destBytes !== sourceBytes) {
  console.error(`[mirror-client] mirror mismatch: source ${sourceBytes} bytes vs ${DEST} ${destBytes} bytes — aborting (the mirror must be byte-identical)`);
  process.exit(1);
}
console.log(`[mirror-client] mirrored ${SOURCE} → ${DEST} (${destBytes} bytes, byte-identical)`);