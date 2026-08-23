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

// Lazify the DSH react externals (react, react/jsx-runtime) that tsdown hoists
// to the TOP of the CJS body as `let react = require("react")`. The DSH client
// test harness loads the bundle with a require stub that THROWS ("the watcher
// bundle imports nothing") — so the factory body must not execute a require
// during evaluation, even though the DSH loader DOES resolve react at runtime.
// Both externals are only ever dereferenced while a React component actually
// RENDERS, so we hold them as lazy Proxy namespaces that resolve the loader's
// require on first property access — still inside the factory, where the
// loader's `require` stays live. Keep these imports name-matched to the tsdown
// output; if the shape drifts, the count guard below fails loudly instead of
// emitting a bundle that violates the envelope.
let lazified = 0;
body = body.replace(
  /^let ([A-Za-z_$][\w$]*) = require\("(react|react\/jsx-runtime)"\);$/gm,
  (_m, ident, spec) => {
    lazified += 1;
    return `let ${ident} = new Proxy({}, { get: (t, p) => (t.m ??= require("${spec}"))[p] });`;
  }
);
if (lazified === 0) {
  console.error(
    "[normalize-client-banner] no react externals found to lazify; the bundle " +
    "would emit top-level requires and break the client test harness. Aborting."
  );
  process.exit(1);
}
// Guard: the DSH react externals are the ONLY top-level requires this plugin
// bundle is allowed to emit; any other `let X = require(...)` at line scope is
// an externals drift that the envelope forbids.
const stray = body.match(/^[ \t]*let [A-Za-z_$][\w$]* = require\(/m);
if (stray) {
  console.error(
    `[normalize-client-banner] unexpected top-level require remains: ${stray[0].trim()}. Aborting.`
  );
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
