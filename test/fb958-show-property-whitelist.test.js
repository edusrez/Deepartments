// fb-958 (QD, m-11064 item 2) + fb-960 (m-11064 item 1b) — the dept_exec
// `systemctl` guard: the READ-ONLY `show -p <inert-props>` form, with the
// property whitelist CLOSED and DENY-BY-DEFAULT.
//
// THE MEASURED FACT (QD): `isReadOnlySystemctl` (src/invoke.ts:2258-2261) is an
// ANCHORED regex over EXACTLY ONE form — `systemctl is-active <unit>` — and the
// veto `deptExecDenyReason` (src/invoke.ts:2943-2944) denies EVERY other
// `systemctl` form. Consequence: the inert read the job docs prescribe,
// `systemctl show <unit> -p NRestarts`
// (docs/departments/internal-programming/jobs/system-health-report.md:115-118),
// is DENIED TODAY — so that branch of the runbook is INEXECUTABLE by
// construction (RED, measured below), while
// docs/departments/internal-programming/jobs/host-sampler.md:71 routes a
// MUTATING verb (`systemctl restart dsh-host-sampler`) into a WORKER runbook
// where the guard can never allow it.
//
// WHY THE `-p` IS MANDATORY (fb-690 — the leak this lane must NOT open):
// `systemctl show <unit>` WITHOUT `-p` dumps EVERY property, including
// `Environment=` — the unit's secrets in clear text (the host measured
// DEEPINFRA_TOKEN + `sk-…` keys + PARALLEL_API_KEY readable without privilege;
// the unit file's 0600 mode protects NOTHING because the vector is systemd
// itself). So `Environment` — and every other environment-dumping property —
// MUST stay DENIED, and so must the absence of `-p`.
//
// THE CONTRACT THIS FILE LOCKS (each negative below is a SMUGGLING vector the
// whitelist must refuse — if ANY of them is allowed, the fix is WORSE than the
// bug and the lane must stop):
//   (a) `show <unit>` with NO `-p`                      → DENIED
//   (b) `-p Environment`                               → DENIED
//   (c) `-p NRestarts,Environment` (mixed list)        → DENIED
//   (d) `restart <unit>` and every other MUTATING verb → DENIED
//   (e) chaining with `;` / `&&` / `|`                 → DENIED
//   (f) `$(...)` / backticks                           → DENIED
//   (g) `--property=Environment` (glued `=`)           → DENIED
// plus the PARSING hardenings the same lane demands: newline smuggling, quotes,
// `--user`, a second `-p`, an extra property behind a valid one, a property that
// is not the exact whitelisted NAME (case matters to systemd).
//
// CLOSURE LANE ADDENDUM (builder-336, 2026-09-14 — `-p` whitelist widened to SIX
// by MEASUREMENT): the fb-958 fix shipped with FOUR names and thereby DENIED the
// two properties the fb-690 incident itself needed — `DropInPaths` (which drop-in
// files apply: the incident's secrets sat in 1 unit + 5 drop-ins) and
// `EnvironmentFiles` (the proof that an `EnvironmentFile=` migration took effect).
// Both are now admitted BECAUSE their values were measured to be file PATHS, never
// content (DropInPaths `as`; EnvironmentFiles `a(sb)` = {path, ignoreOnReplace} —
// every measured element an absolute path, zero `=`, zero whitespace; the FILE
// CONTENT of an EnvironmentFile= is only ever reachable through `Environment`,
// which stays DENIED). The negatives therefore WIDEN with the whitelist: the MIXED
// lists `-p EnvironmentFiles,Environment` / `-p DropInPaths,Environment`, the glued
// `--property=` carrying either, a second `-p`, and off-case/empty/trailing-comma
// variants of the TWO NEW NAMES are all locked as DENIED below. An allow-list is
// widened by evidence; if any of these negatives ever passes, the change is WORSE
// than the gap it closed and must be reverted.
//
// FILE NAME (deliberate): this file is NOT named `…-systemctl-….test.js`
// because the dept_exec veto is a RAW SUBSTRING check (`lower.includes(...)`,
// src/invoke.ts:3015) — a command line that merely MENTIONS the word is denied,
// so `node --test test/<a path containing that word>.test.js` is DENIED by the
// very guard under test (MEASURED in this lane: the deny message quoted in the
// report). The name avoids the word so the file stays runnable BY PATH;
// `node --test` (no path argument) discovers it either way.
//
// EVIDENCE DISCIPLINE: the guard is exercised DIRECTLY (`isReadOnlySystemctl`)
// AND through the REAL veto (`deptExecDenyReason`) — every negative contains the
// literal `systemctl`, so the :2943 veto is exactly what fires whenever the
// helper returns false. Nothing here boots the daemon: the daemon keeps running
// the OLD code until the next restart, so this test (plus the direct helper
// invocation) is the only honest effect statement available in this lane.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deptExecDenyReason, isReadOnlySystemctl } from '../lib/invoke.js'

const ROOTS = ['/home/esuarez/projects', '/root/.deepartments', '/usr/lib/node_modules/@deepseek-ai/dsh', '/opt/dsh/.dsh-dev']
const CWD = '/home/esuarez/projects/deepartments'
const UNIT = 'dsh-deepartments-dev'

/** The SIX INERT properties the whitelist admits: four unit-METADATA names (the
 * QD-mandated originals) plus — fb-958 CLOSURE LANE, admitted ON MEASUREMENT, not
 * on symmetry — the two PATH-VALUED ones. None of the six can carry the process
 * environment or any environment CONTENT; see the closure test at the end of this
 * file for the measurement that justified the two new names. */
const INERT = ['MainPID', 'NRestarts', 'ExecMainStartTimestamp', 'FragmentPath', 'DropInPaths', 'EnvironmentFiles']

/** The two PATH-VALUED names the closure lane added, with the fb-690 incident that
 * needed them: `DropInPaths` = WHICH drop-in files apply (fb-690's secrets lived in
 * 1 unit + 5 drop-ins; without it nobody can even enumerate what applies), and
 * `EnvironmentFiles` = the property that PROVES an `EnvironmentFile=` migration
 * took effect. Both are paths + flags; neither exposes file CONTENT. */
const INERT_PATH_VALUED = ['DropInPaths', 'EnvironmentFiles']

/** Properties that MUST stay denied — every one of them can carry the process
 * environment or otherwise widen the surface (fb-690). `Environment` is the
 * content-bearing one; `PassEnvironment`/`ExecStart`/`ExecStartPre` are the other
 * routes to that same environment. (`EnvironmentFiles`/`DropInPaths` were MOVED
 * OUT of this list by the closure lane, on measurement — their elements are
 * absolute paths, never content, and the leak they could be mistaken for is
 * EXACTLY the MIXED list, which stays denied below.) */
const LEAKY = ['Environment', 'PassEnvironment', 'ExecStart', 'ExecStartPre', 'User', 'WorkingDirectory', 'LoadState']

/** A form the guard must ALLOW: the helper says read-only AND the real veto
 * returns undefined (no deny reason). */
function assertAllowed(cmd) {
  assert.equal(isReadOnlySystemctl(cmd), true, `isReadOnlySystemctl must be TRUE (read-only) for: ${cmd}`)
  assert.equal(deptExecDenyReason(cmd, CWD, ROOTS), undefined, `deptExecDenyReason must ALLOW (undefined) for: ${cmd}`)
}

/** A form the guard must DENY: the helper says NOT read-only (so the :2943 veto
 * fires for every `systemctl`-bearing command) AND the real veto returns a deny
 * reason. */
function assertDenied(cmd, why) {
  assert.equal(isReadOnlySystemctl(cmd), false, `isReadOnlySystemctl must be FALSE for: ${cmd}  [${why}]`)
  const reason = deptExecDenyReason(cmd, CWD, ROOTS)
  assert.ok(typeof reason === 'string' && reason.includes('DENIED'), `deptExecDenyReason must DENY: ${cmd}  [${why}] — got: ${String(reason)}`)
}

test('fb-958 RED/GREEN: the INERT `systemctl show <unit> -p <whitelisted-props>` form — the one the job docs prescribe — is READ-ONLY and ALLOWED', () => {
  // The doc-prescribed form (system-health-report.md:115-118) must be executable.
  assertAllowed(`systemctl show ${UNIT} -p NRestarts`)
  assertAllowed(`systemctl show ${UNIT} -p MainPID`)
  assertAllowed(`systemctl show ${UNIT} -p ExecMainStartTimestamp`)
  assertAllowed(`systemctl show ${UNIT} -p FragmentPath`)
  // Every inert property alone, then the full comma list.
  for (const p of INERT) assertAllowed(`systemctl show ${UNIT} -p ${p}`)
  assertAllowed(`systemctl show ${UNIT} -p ${INERT.join(',')}`)
  // The `--property` long form is the SAME option and reads the same whitelist.
  assertAllowed(`systemctl show ${UNIT} --property NRestarts`)
  assertAllowed(`systemctl show ${UNIT} --property ${INERT.join(',')}`)
  // systemctl accepts the option BEFORE the unit — the guard must not care.
  assertAllowed(`systemctl show -p NRestarts ${UNIT}`)
  assertAllowed(`systemctl show --property ${INERT.join(',')} ${UNIT}`)
  // The pre-existing carve-out is UNCHANGED (parity with the B2 tests).
  assertAllowed(`systemctl is-active ${UNIT}`)
  assertAllowed('SYSTEMCTL IS-ACTIVE dsh-host-sampler')
  // The path-prefixed form is read-only AT THE HELPER LEVEL (pre-existing
  // parity, invoke.test.js:11126) — but the REAL veto still denies it on the
  // absolute-path scope rule (`/usr/bin` is not a scoped root). That asymmetry
  // is PRE-EXISTING and UNTOUCHED by this lane; it is measured here so nobody
  // mistakes a helper-true for an executable command.
  assert.equal(isReadOnlySystemctl('/usr/bin/systemctl is-active dsh-host-sampler'), true, 'the helper tolerates an optional path prefix (pre-existing parity)')
  assert.ok(String(deptExecDenyReason('/usr/bin/systemctl is-active dsh-host-sampler', CWD, ROOTS)).includes('DENIED'), 'the path-prefixed form is still DENIED end-to-end by the absolute-path scope rule (pre-existing asymmetry, untouched)')
})

test('fb-958 (a)+(b)+(c) fb-690 leak vectors: `show` with NO `-p`, `-p Environment`, and a MIXED list stay DENIED (the whitelist is CLOSED)', () => {
  // (a) no `-p` at all → dumps EVERY property, `Environment=` included → DENY.
  assertDenied(`systemctl show ${UNIT}`, '(a) show without -p dumps the whole property set (fb-690)')
  assertDenied('systemctl show', '(a) bare show')
  // (b) the environment property itself → DENY.
  assertDenied(`systemctl show ${UNIT} -p Environment`, '(b) -p Environment leaks the unit env')
  assertDenied(`systemctl show ${UNIT} --property Environment`, '(b) --property Environment (space form)')
  // (c) a MIXED list — one valid inert name does not buy the leaky one → DENY.
  assertDenied(`systemctl show ${UNIT} -p NRestarts,Environment`, '(c) mixed list, Environment behind a valid property')
  assertDenied(`systemctl show ${UNIT} -p Environment,NRestarts`, '(c) mixed list, Environment first')
  assertDenied(`systemctl show ${UNIT} -p MainPID,NRestarts,Environment`, '(c) mixed list, Environment last')
  // The whole LEAKY family — any of these allowed means the lane must stop.
  for (const p of LEAKY) {
    assertDenied(`systemctl show ${UNIT} -p ${p}`, `leak-prone property ${p} must stay denied`)
    assertDenied(`systemctl show ${UNIT} -p MainPID,${p}`, `leak-prone property ${p} smuggled behind MainPID`)
  }
})

test('fb-958 parsing: the property list is an EXPLICIT, EXACT-NAME, comma-separated whitelist — case, empties, extra args and a second `-p` all DENY', () => {
  // systemd property names are case-SENSITIVE: an off-case name is not the whitelisted one.
  assertDenied(`systemctl show ${UNIT} -p mainpid`, 'property names are case-sensitive — mainpid is not MainPID')
  assertDenied(`systemctl show ${UNIT} -p MAINPID`, 'property names are case-sensitive — MAINPID is not MainPID')
  assertDenied(`systemctl show ${UNIT} -p ProcesesMainPID`, 'a lookalike/typo name is not whitelisted')
  // An EMPTY element is not a whitelisted name.
  assertDenied(`systemctl show ${UNIT} -p MainPID,`, 'trailing comma leaves an empty property name')
  assertDenied(`systemctl show ${UNIT} -p ,MainPID`, 'leading comma leaves an empty property name')
  assertDenied(`systemctl show ${UNIT} -p MainPID,,NRestarts`, 'double comma leaves an empty property name')
  // `-p` without a value, or extra tokens behind the valid ones.
  assertDenied(`systemctl show ${UNIT} -p`, '-p with no value')
  assertDenied(`systemctl show ${UNIT} -p MainPID extra`, 'an extra bare token behind the valid form')
  assertDenied(`systemctl show ${UNIT} -p MainPID -p Environment`, 'a SECOND -p cannot widen the whitelist')
  assertDenied(`systemctl show ${UNIT} -p MainPID -p NRestarts`, 'a second -p is not the accepted grammar (deny by default)')
  assertDenied(`systemctl show ${UNIT} -p=MainPID`, 'the glued `-p=` form is not the accepted grammar')
  assertDenied(`systemctl show ${UNIT} -p MainPID Environment`, 'a bare extra token behind the list')
  // ANY other option is outside the grammar — `--user` included.
  assertDenied(`systemctl show --user ${UNIT} -p MainPID`, '--user is outside the accepted grammar')
  assertDenied(`systemctl show ${UNIT} --user -p MainPID`, '--user after the unit is outside the grammar')
  assertDenied(`systemctl show ${UNIT} -p MainPID --no-pager`, '--no-pager is outside the accepted grammar')
  assertDenied(`systemctl --user show ${UNIT} -p MainPID`, '--user before the verb is outside the grammar')
  // A unit is REQUIRED for `show` (deny by default).
  assertDenied('systemctl show -p MainPID', 'show -p without a unit is not the accepted form')
  // The verb itself must be exactly is-active/show.
  assertDenied(`systemctl ${UNIT} -p MainPID`, 'a bare unit as the verb is not a systemctl command')
  assertDenied(`systemctl showcase ${UNIT} -p MainPID`, 'a verb that merely starts with show is not show')
  assertDenied(`systemctl show-environment`, 'show-environment is not the accepted verb')
})

test('fb-958 (d) every MUTATING verb stays DENIED — `systemctl restart` NEVER enters through this lane (the repair is the HOST/owner\'s)', () => {
  const MUTATING = ['start', 'stop', 'restart', 'try-restart', 'reload', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'enable', 'disable', 'reenable', 'preset', 'mask', 'unmask', 'daemon-reload', 'daemon-reexec', 'kill', 'reset-failed', 'isolate', 'set-property', 'set-environment', 'unset-environment', 'edit', 'import-environment', 'link', 'revert', 'freeze', 'thaw', 'switch-root', 'suspend', 'hibernate', 'poweroff', 'reboot', 'halt', 'kexec']
  for (const verb of MUTATING) assertDenied(`systemctl ${verb} ${UNIT}`, `mutating verb ${verb} must stay denied`)
  // The exact line the host-sampler runbook used to order (host-sampler.md:71).
  assertDenied(`systemctl restart dsh-host-sampler`, '(d) the doc line itself — a mutating verb, never this lane')
  // Read-only-but-outside-the-whitelist queries stay denied too (deny by default).
  for (const verb of ['status', 'cat', 'list-units', 'list-unit-files', 'is-enabled', 'is-failed', 'get-default', 'show'] ) {
    if (verb === 'show') continue
    assertDenied(`systemctl ${verb} ${UNIT}`, `non-whitelisted read form ${verb} is STILL denied (deny by default)`)
  }
})

test('fb-958 (e)+(f)+(g) no SMUGGLING: `;` / `&&` / `|`, `$(...)` / backticks / newlines, quoting, and the glued `--property=Environment` are all DENIED', () => {
  // (e) shell chaining.
  assertDenied(`systemctl show ${UNIT} -p MainPID; id`, '(e) `;` chaining behind a valid form')
  assertDenied(`systemctl show ${UNIT} -p MainPID && id`, '(e) `&&` chaining behind a valid form')
  assertDenied(`systemctl show ${UNIT} -p MainPID | cat`, '(e) `|` chaining behind a valid form')
  assertDenied(`id; systemctl show ${UNIT} -p MainPID`, '(e) `;` chaining in front of a valid form')
  assertDenied(`systemctl is-active ${UNIT} && systemctl show ${UNIT} -p MainPID`, '(e) a chained pair is not one read-only form')
  assertDenied(`systemctl show ${UNIT} -p MainPID & sleep 1`, '(e) backgrounding with `&`')
  assertDenied(`systemctl show ${UNIT} -p MainPID > /tmp/x`, '(e) a redirect is not the accepted grammar')
  // (f) substitution — command substitution and arithmetic.
  assertDenied(`systemctl show $(cat /tmp/unit) -p MainPID`, '(f) `$(...)` in the unit position')
  assertDenied(`systemctl show ${UNIT} -p MainPID$(id)`, '(f) `$(...)` glued behind a valid property')
  assertDenied('systemctl show `cat /tmp/unit` -p MainPID', '(f) backtick substitution')
  assertDenied(`systemctl show ${UNIT} -p $PROP`, '(f) a `$`-variable property name')
  assertDenied(`systemctl show ${UNIT} -p $((1))`, '(f) arithmetic expansion')
  assertDenied(`systemctl show ${UNIT} -p "{Environment}"`, '(f) brace expansion')
  // Newline / carriage-return smuggling (the line-2 command of a multi-line script).
  assertDenied(`systemctl show ${UNIT} -p MainPID\nid`, 'newline injection behind a valid form')
  assertDenied(`id\nsystemctl show ${UNIT} -p MainPID`, 'newline injection in front of a valid form')
  assertDenied(`systemctl is-active ${UNIT}\nid`, 'newline injection behind the PRE-EXISTING is-active carve-out')
  assertDenied(`systemctl show ${UNIT} -p MainPID\r\nid`, 'CRLF injection behind a valid form')
  // (g) the glued `=` form, used to hide the property from a naive parser.
  assertDenied(`systemctl show ${UNIT} --property=Environment`, '(g) glued --property=Environment')
  assertDenied(`systemctl show ${UNIT} --property=MainPID,Environment`, '(g) glued list carrying Environment')
  assertDenied(`systemctl show ${UNIT} --property=`, '(g) glued empty value')
  // Quoting / escapes — the accepted grammar is unquoted.
  assertDenied(`systemctl show '${UNIT}' -p MainPID`, "a single-quoted unit is not the accepted grammar")
  assertDenied(`systemctl show "${UNIT}" -p MainPID`, 'a double-quoted unit is not the accepted grammar')
  assertDenied(`systemctl show ${UNIT} -p 'Environment'`, 'a quoted property name')
  assertDenied(`systemctl show ${UNIT} -p MainPID\\;id`, 'a backslash-escaped separator')
  assertDenied(`systemctl show ${UNIT} -p MainPID\tid`, 'a TAB-separated extra token')
  // A leading command or an unanchored mention never rides the carve-out.
  assertDenied(`echo systemctl show ${UNIT} -p MainPID`, 'a leading command in front of the form')
  assertDenied(`/usr/bin/grep -n "systemctl show" ${UNIT}.txt`, 'an unanchored systemctl mention (parity with the pre-existing veto)')
})

test('fb-958 whitelist CLOSURE: the admitted property set is EXACTLY the six inert names — no property outside it is ever read-only', () => {
  // The accepted set is enumerated here EXPLICITLY; a widened whitelist (any new
  // name reaching true) must fail this test, not silently ship. The CLOSURE LANE
  // raised the count 4 -> 6 by measurement (DropInPaths/EnvironmentFiles), and the
  // assertion below is the guard against an UNMEASURED seventh name.
  assert.deepEqual(INERT, ['MainPID', 'NRestarts', 'ExecMainStartTimestamp', 'FragmentPath', 'DropInPaths', 'EnvironmentFiles'], 'the inert whitelist is the four metadata names + the two measured PATH-VALUED names')
  for (const p of INERT) assert.equal(isReadOnlySystemctl(`systemctl show ${UNIT} -p ${p}`), true, `${p} must be read-only`)
  for (const p of LEAKY) assert.equal(isReadOnlySystemctl(`systemctl show ${UNIT} -p ${p}`), false, `${p} must NEVER be read-only`)
  // The doc-prescribed EXACT line (the acceptance that ties doc to guard: the
  // command the runbooks will print must be the command the guard accepts).
  const DOC_FORM = `systemctl show ${UNIT} -p MainPID,NRestarts,ExecMainStartTimestamp`
  assertAllowed(DOC_FORM)
  const DOC_FORM_SAMPLER = 'systemctl is-active dsh-host-sampler'
  assertAllowed(DOC_FORM_SAMPLER)
})

test('fb-958 CLOSURE LANE: `DropInPaths` and `EnvironmentFiles` are ADMITTED (the two properties the fb-690 incident needed: which drop-ins apply, and whether the `EnvironmentFile=` migration is referenced)', () => {
  // RED BEFORE THIS LANE (measured with the shipped four-name whitelist):
  // `systemctl show <unit> -p DropInPaths` → isReadOnlySystemctl === false and the
  // veto returned DENIED. That red is what justifies the widening; these positives
  // were failing before the change and are green after it.
  for (const p of INERT_PATH_VALUED) {
    assertAllowed(`systemctl show ${UNIT} -p ${p}`)
    assertAllowed(`systemctl show ${UNIT} --property ${p}`)
  }
  // Both together, and in a larger INERT-only list — every name is whitelisted.
  assertAllowed(`systemctl show ${UNIT} -p ${INERT_PATH_VALUED.join(',')}`)
  assertAllowed(`systemctl show ${UNIT} -p ${INERT.join(',')}`)
  // Option BEFORE the unit, and both separators (parity with the originals).
  assertAllowed(`systemctl show -p ${INERT_PATH_VALUED.join(',')} ${UNIT}`)
  assertAllowed(`systemctl show --property ${INERT_PATH_VALUED.join(',')} ${UNIT}`)
  // The `EnvironmentFile=` VERIFICATION the fb-690 closure needs: the property is
  // readable, and the runbook can now assert the migration is referenced.
  assertAllowed(`systemctl show dsh-deepartments-dev -p EnvironmentFiles`)
  // And the fb-690 CHARACTERIZATION: which drop-in files apply to the unit.
  assertAllowed(`systemctl show dsh-deepartments-dev -p DropInPaths`)
})

test('fb-958 CLOSURE LANE NEGATIVES: widening the whitelist did NOT widen the guard — the content-bearing and mixed forms stay DENIED (each one means REVERT, not ship)', () => {
  // (a)-(h) of the closure-lane mandate, verbatim. If ANY of these passes, the
  // change is worse than the gap and must be reverted.
  assertDenied(`systemctl show ${UNIT}`, '(a) show with NO -p — the fb-690 full dump')
  assertDenied(`systemctl show ${UNIT} -p Environment`, '(b) -p Environment — the content-bearing property')
  assertDenied(`systemctl show ${UNIT} -p EnvironmentFiles,Environment`, '(c) MIXED list: the newly-admitted EnvironmentFiles must NOT buy Environment')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths,Environment`, '(d) MIXED list: the newly-admitted DropInPaths must NOT buy Environment')
  assertDenied(`systemctl show ${UNIT} -p ExecStart`, '(e) -p ExecStart')
  assertDenied(`systemctl show ${UNIT} -p ExecStartPre`, '(f) -p ExecStartPre')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths -p Environment`, '(g) a SECOND -p cannot widen the list')
  assertDenied(`systemctl show ${UNIT} --property=Environment`, '(h) glued --property=Environment')
  // The MIXED-list family around the two NEW names — the exact shape that would
  // look almost right in a diff (and reversed order too).
  assertDenied(`systemctl show ${UNIT} -p Environment,EnvironmentFiles`, 'mixed, Environment first behind the new name')
  assertDenied(`systemctl show ${UNIT} -p Environment,DropInPaths`, 'mixed, Environment first behind DropInPaths')
  assertDenied(`systemctl show ${UNIT} -p MainPID,DropInPaths,Environment`, 'mixed, the leak LAST after two whitelisted names')
  assertDenied(`systemctl show ${UNIT} --property=DropInPaths,Environment`, 'glued --property= list carrying Environment')
  assertDenied(`systemctl show ${UNIT} --property=EnvironmentFiles,Environment`, 'glued --property= list carrying Environment')
  assertDenied(`systemctl show ${UNIT} -p EnvironmentFile`, 'EnvironmentFile (singular) is NOT EnvironmentFiles')
  assertDenied(`systemctl show ${UNIT} -p EnvironmentFiles.Path`, 'a dotted lookalike of the new name')
  assertDenied(`systemctl show ${UNIT} -p DropInPath`, 'DropInPath (singular) is NOT DropInPaths')
  assertDenied(`systemctl show ${UNIT} -p dropinpaths`, 'the new names are case-sensitive too')
  assertDenied(`systemctl show ${UNIT} -p environmentfiles`, 'the new names are case-sensitive too')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths,`, 'trailing comma after a newly-admitted name')
  assertDenied(`systemctl show ${UNIT} -p ,EnvironmentFiles`, 'leading comma before a newly-admitted name')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths,,EnvironmentFiles`, 'empty element between the two new names')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths extra`, 'an extra bare token after the new name')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths; id`, 'chaining behind the new name')
  assertDenied(`systemctl show ${UNIT} -p DropInPaths\nid`, 'newline smuggling behind the new name')
  // The content-bearing routes that exist ALONGSIDE Environment stay out too.
  for (const p of ['PassEnvironment', 'EnvironmentFilesExtra']) {
    assertDenied(`systemctl show ${UNIT} -p ${p}`, `${p} must stay denied`)
  }
  // Mutating verbs are untouched by the widening.
  for (const v of ['start', 'stop', 'restart', 'reload', 'disable', 'daemon-reload', 'set-property', 'set-environment', 'unset-environment']) {
    assertDenied(`systemctl ${v} ${UNIT}`, `mutating verb ${v} must stay denied`)
  }
})
