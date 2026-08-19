/**
 * normalize-client-banner.mjs
 *
 * Wraps the raw tsdown CJS output (client/client.tmp.js) in the DSH
 * client ModuleLoader envelope and writes the final client/client.js.
 *
 * The tsdown bundle is emitted WITHOUT a `window.__ModuleLoader__.load(...)`
 * banner (it is a plain CJS module whose body finishes with the plugin's
 * named exports, e.g. `exports.apply` / `exports.inject`). This script
 * prepends the loader call and provides the `module`/`exports` locals that
 * Cordis-style client plugins expect, matching the official sidebar bundle
 * and the dshmarket reference envelope.
 *
 * Envelope (required by the DSH client loader):
 *   window.__ModuleLoader__.load({
 *     id: "dsh-deepartments",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       <bundled body>
 *       return module.exports;
 *     }
 *   });
 *
 * The loader reads the plugin object from module.exports, so the body must
 * assign the plugin surface onto `exports` before returning.
 */
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_DIR = join(ROOT, "client");
const OUT = join(CLIENT_DIR, "client.js");
const ID = "dsh-deepartments";

// The tsdown intermediate filename is derived from the entry basename; locate
// exactly one *.tmp.js in the client output dir rather than hard-coding it.
const candidates = readdirSync(CLIENT_DIR).filter((f) => f.endsWith(".tmp.js"));
const TMP = candidates.length === 1 ? join(CLIENT_DIR, candidates[0]) : null;

if (!TMP || !existsSync(TMP)) {
  console.error(`[normalize-client-banner] expected exactly one intermediate *.tmp.js in ${CLIENT_DIR}, found: ${candidates.join(", ") || "(none)"}`);
  process.exit(1);
}

let body = readFileSync(TMP, "utf8").trim();

// Guard: the emitted body must not contain ESM import/export statements
// (string-literal occurrences are fine; real ESM syntax is not).
if (/^\s*(import|export)\s/m.test(body)) {
  console.error("[normalize-client-banner] ESM syntax detected in bundle body; aborting.");
  process.exit(1);
}

const envelope =
  `window.__ModuleLoader__.load({\n` +
  `  id: "${ID}",\n` +
  `  factory: (require) => {\n` +
  `    var module = { exports: {} };\n` +
  `    var exports = module.exports;\n` +
  `    ${body.replace(/\n/g, "\n    ")}\n` +
  `    return module.exports;\n` +
  `  }\n` +
  `});\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, envelope, "utf8");

// Remove the intermediate file.
unlinkSync(TMP);

console.log(`[normalize-client-banner] wrote ${OUT} (${envelope.length} bytes)`);
