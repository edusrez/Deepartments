// A-HARNESS PORT post-apply smoke (builder-173, run token cfc0afac, 2026-09-07).
// Headless and read-only: imports the INSTALLED runtime packages by absolute
// file:// URL (their own bare imports resolve against the live tree) and
// asserts the A-HARNESS payload behaviors. Run AFTER the host applies
// scripts/reapply-dsh-patches-a-harness.sh apply. Expected result: 11/11
// probe groups PASS (exit 0). BEFORE the apply, the fb-102/fb-85/fb-89/R3
// assertions fail — that failure IS the expected pre-apply signal.
//
//   node scripts/a-harness-smoke.mjs
//
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const RT = '/usr/lib/node_modules/@deepseek-ai/dsh'
const P = (f) => `file://${RT}/node_modules/@deepseek-ai/${f}/lib/index.js`

let pass = 0
const ok = (name) => { console.log(`PASS ${name}`); pass++ }

// 1. dsh-tool-fs-search: anchorGlobPattern + buildGlobCommand (payload fs-search)
const fsSearch = await import(P('dsh-tool-fs-search'))
assert.equal(fsSearch.anchorGlobPattern('dshd-orchestration/**', 'packages'), '**/dshd-orchestration/**')
assert.equal(fsSearch.anchorGlobPattern('src/*.ts', 'packages'), '**/src/*.ts')
assert.equal(fsSearch.anchorGlobPattern('package.json', 'packages'), '**/package.json')
assert.equal(fsSearch.anchorGlobPattern('*.ts', 'packages'), '*.ts')
assert.equal(fsSearch.anchorGlobPattern('**/*.ts', 'packages'), '**/*.ts')
assert.equal(fsSearch.anchorGlobPattern('?oo/**', 'packages'), '?oo/**')
assert.equal(fsSearch.anchorGlobPattern('[ab]/**', 'packages'), '[ab]/**')
assert.equal(fsSearch.anchorGlobPattern('{a,b}/**', 'packages'), '{a,b}/**')
assert.equal(fsSearch.anchorGlobPattern('!x/**', 'packages'), '!x/**')
assert.equal(fsSearch.anchorGlobPattern('/rooted/**', 'packages'), '/rooted/**')
assert.equal(fsSearch.anchorGlobPattern('dshd-orchestration/**', undefined), 'dshd-orchestration/**')
const argv = fsSearch.buildGlobCommand({ pattern: 'dshd-orchestration/**', path: 'packages' })
assert.equal(argv[1], '--glob=**/dshd-orchestration/**')
assert.ok(argv[argv.length - 2] === '--' && argv[argv.length - 1] === 'packages')
ok('dsh-tool-fs-search anchorGlobPattern + buildGlobCommand (15 assertions)')

// 2. dsh-tool-web: parseFetchArgs timeout_ms override + DEFAULT_FETCH_MAX_TIMEOUT_MS
const toolWeb = await import(P('dsh-tool-web'))
assert.deepEqual(toolWeb.parseFetchArgs({ url: 'https://a.test' }), { url: 'https://a.test' })
assert.deepEqual(toolWeb.parseFetchArgs({ url: 'https://a.test', timeout_ms: 5_000 }), { url: 'https://a.test', timeoutMs: 5_000 })
assert.throws(() => toolWeb.parseFetchArgs({ url: 'https://a.test', timeout_ms: 0 }), /timeout_ms must be a positive finite number/)
assert.throws(() => toolWeb.parseFetchArgs({ url: 'https://a.test', timeout_ms: Number.NaN }), /timeout_ms must be a positive finite number/)
assert.throws(() => toolWeb.parseFetchArgs({ url: '  ' }), /url must be a non-empty string/)
assert.equal(toolWeb.DEFAULT_FETCH_MAX_TIMEOUT_MS, 120_000)
assert.equal(toolWeb.DEFAULT_WEB_TOOL_TIMEOUT_MS, 30_000)
ok('dsh-tool-web parseFetchArgs/DEFAULT_FETCH_MAX_TIMEOUT_MS (7 assertions)')

// 3. dsh-app-boot: watchUserPatchLayers exported + watchUserPatches wrapper kept
const appBoot = await import(P('dsh-app-boot'))
assert.equal(typeof appBoot.watchUserPatchLayers, 'function')
assert.equal(typeof appBoot.watchUserPatches, 'function')
ok('dsh-app-boot watchUserPatchLayers + watchUserPatches exported')

// 4. dsh-fs-local: nearestLiteralHint logic present (module-internal; byte probe)
const fsLocalText = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js`, 'utf8')
assert.match(fsLocalText, /nearestLiteralHint\(content, oldNorm\)/)
assert.match(fsLocalText, /found with different indentation \(line \$\{index \+ 1\}\)/)
assert.match(fsLocalText, /closest line \(\$\{bestLine\}\)/)
ok('dsh-fs-local nearestLiteralHint + hint strings present in the bundle')

// 5. dsh-tool-fs: FS_EDIT_NOT_FOUND remedy appended (byte probe; module-internal)
const toolFsText = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`, 'utf8')
assert.match(toolFsText, /FS_EDIT_NOT_FOUND: "read the file, then retry with the exact literal/)
assert.match(toolFsText, /re-read the file, then retry \(your last observation predates the file/)
ok('dsh-tool-fs remediateFsError remedies (FS_EDIT_NOT_FOUND + FS_STALE_VERSION)')

// 6. dsh-fs-observation-policy: session-freshness message
const fsObsText = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-fs-observation-policy/lib/index.js`, 'utf8')
assert.match(fsObsText, /no fresh observation of it in THIS session/)
ok('dsh-fs-observation-policy FS_NOT_OBSERVED message')

// 7. dsh-web types: WebFetchRequest.timeoutMs decl
const webTypes = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-web/lib/types/types.d.ts`, 'utf8')
assert.match(webTypes, /readonly timeoutMs\?: number/)
ok('dsh-web WebFetchRequest.timeoutMs declared')

// 8. dsh-tool-web types: FetchArgs + fetchMaxTimeoutMs
const twFetchTypes = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-tool-web/lib/types/fetch.d.ts`, 'utf8')
assert.match(twFetchTypes, /export interface FetchArgs/)
assert.match(twFetchTypes, /timeout_ms\?: number/)
const twIdxTypes = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-tool-web/lib/types/index.d.ts`, 'utf8')
assert.match(twIdxTypes, /fetchMaxTimeoutMs/)
ok('dsh-tool-web types FetchArgs/timeout_ms/fetchMaxTimeoutMs')

// 9. dsh-app-boot types: watchUserPatchLayers decl
const abTypes = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-app-boot/lib/types/index.d.ts`, 'utf8')
assert.match(abTypes, /watchUserPatchLayers/)
assert.match(abTypes, /UserPatchLayerWatchOptions/)
ok('dsh-app-boot types watchUserPatchLayers')

// 10. dsh CLI profile-boot chunk: watchUserPatchLayers call + bundle layers
const { execFileSync } = await import('node:child_process')
let chunk = ''
for (const f of execFileSync('bash', ['-c', `ls ${RT}/lib/profile-boot-*.js`], { encoding: 'utf8' }).trim().split('\n')) {
  const t = readFileSync(f, 'utf8')
  if (t.includes('runProfile') && t.includes('@deepseek-ai/dsh-app-boot')) chunk = t
}
assert.match(chunk, /watchUserPatchLayers\(ctx/)
assert.match(chunk, /layers: \[/)
assert.match(chunk, /required: true/)
assert.match(chunk, /composed\.profile\.layers\.map/)
ok('dsh CLI profile-boot chunk: watchUserPatchLayers layers call')

// 11. dsh-tool-fs-search: path-not-found class (VALLE 09-08 lane) — the
// SEARCH_PATH_NOT_FOUND branch (pre-check + stderr fallback), the clean
// `path not found: <path>` message and the pattern-rejection wording present
// in the bundle; the OLD raw-stderr wording is gone. Byte-probe (headless);
// the behavior itself is pinned by the fork integration suite.
const fsSearchText2 = readFileSync(`${RT}/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js`, 'utf8')
assert.match(fsSearchText2, /path not found: /)
assert.match(fsSearchText2, /SEARCH_PATH_NOT_FOUND/)
assert.match(fsSearchText2, /pattern rejected: /)
assert.ok(!fsSearchText2.includes('pattern rejected by ripgrep:'), 'the raw-stderr pattern wording must be replaced')
assert.match(fsSearchText2, /An empty result means the pattern matched nothing under an existing path/)
ok('dsh-tool-fs-search path-not-found class (SEARCH_PATH_NOT_FOUND + clean wording + MODO 3 docs)')

console.log(`\nSMOKE RESULT: ${pass}/11 probe groups PASS (A-HARNESS applied)`)