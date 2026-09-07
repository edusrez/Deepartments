// dsh-deepartments — R5 DX-GUARDS test (LANE R5: «familia feedback DX + guard
// FPs», run token 05ee087c). Reproduces + locks the round's fixes:
//
//   - fb-88/fb-114 — dept_memo_write rejected malformed calls with the TERSE
//     'missing required property "summary"' WITHOUT listing the unknown/extra
//     keys (the IPH call with 2-3 invented keys; the QH omission of summary).
//     The post own-layer memo tool now registers with a STRICT compiled param
//     schema (additionalProperties:false — mutations at the registration site,
//     tools.ts installHeadBoardTools) so the harness INVALID_ARGS enumerates
//     BOTH the missing required AND every undeclared key in one message.
//   - fb-135 — grep/dept_exec over a NON-EXISTENT package path returned only
//     'exit code 2'/'IO error' with no discovery hint (typo «dsh-key-pooler»
//     vs «dshd-pooler»). dept_exec now appends «usa glob para listar
//     packages/» to (a) the guard DENY of a missing packages token and (b) a
//     FAILED run whose command references a missing /packages/<name>.
//   - fb-138 — the node --test-name-pattern '/pooler/i' FP: a `/`-leading
//     token that is the VALUE of a KNOWN pattern-valued binary flag was DENIED
//     as an absolute path; the path scan now skips flag VALUES.
//   - fb-142 — git commit -m "…(projected+reserve)/contextWindow…" FP: a
//     `/`-token inside a `git commit -m "…"` MESSAGE span is message TEXT, not
//     a path (the `(`/`)` tokenizer boundaries extracted `/contextWindow`).
//
// Controls locked: fb-62/53 intact (rm -rf / still DENIED; /etc/passwd still
// DENIED; in-root paths still allowed; the denylist unchanged).
//
// Hermetic: temp stateDir; the E2 boots the REAL Loader composition (the
// tools-factory smokeBoot pattern) and exercises the REAL head own-layer
// dept_memo_write + dept_exec paths.
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'
import { deptExecDenyReason, DEPT_EXEC_DEFAULT_ROOTS } from '../lib/invoke.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

// ---------------------------------------------------------------------------
// PURE GUARD TESTS (fb-138 / fb-142 / fb-135 deny-side / controls) — the
// guard is the PURE deptExecDenyReason the dept_exec tool runs.
// ---------------------------------------------------------------------------

const ROOTS = [...DEPT_EXEC_DEFAULT_ROOTS, '/srv/dept-ws']
const CWD = '/srv/dept-ws'

test('R5 fb-138: the node --test-name-pattern "/pooler/i" flag VALUE is NOT an absolute path (quoted, unquoted, --include)', () => {
  assert.equal(deptExecDenyReason("node --test --test-name-pattern '/pooler/i'", CWD, ROOTS), undefined, 'the quoted regex flag value of --test-name-pattern is allowed (fb-138 FP)')
  assert.equal(deptExecDenyReason('node --test --test-name-pattern /pooler/i', CWD, ROOTS), undefined, 'the unquoted regex flag value is allowed too')
  assert.equal(deptExecDenyReason("node --test --test-skip-pattern '/pooler/i'", CWD, ROOTS), undefined, '--test-skip-pattern joins the pattern-flag family')
  assert.equal(deptExecDenyReason("grep --include '/pooler/*.ts' f", CWD, ROOTS), undefined, '--include takes a GLOB (content pattern), never a path')
  assert.equal(deptExecDenyReason("grep --exclude '/pooler/*.ts' f", CWD, ROOTS), undefined, '--exclude joins the pattern-flag family')
})

test('R5 fb-138 controls: the pattern-flag carve-out NEVER relaxes real path protection', () => {
  const wipe = 'rm -rf ' + '/'
  assert.match(deptExecDenyReason(wipe, CWD, ROOTS), /denied token "rm -rf \/"/, 'fb-62: rm -rf / is STILL denied')
  assert.match(deptExecDenyReason('cat /etc/passwd', CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'fb-53: a real out-of-root path is STILL denied')
  assert.equal(deptExecDenyReason('cat /home/esuarez/projects/README.md', CWD, ROOTS), undefined, 'a real IN-ROOT path is still allowed')
  assert.match(deptExecDenyReason('sudo ls', CWD, ROOTS), /denied token "sudo"/, 'the denylist is unchanged (sudo)')
  assert.match(deptExecDenyReason('cat /opt/dsh/.dsh/agent.cordis.yml', CWD, ROOTS), /the stable profile is protected/, 'the stable profile is still protected-denied')
  // A flag that takes a PATH value is NOT in the pattern-flag set — the value
  // keeps being a path word (the carve-out is only the known pattern flags).
  assert.match(deptExecDenyReason('ls --color /etc/passwd', CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'a NON-pattern flag (--color) does not mask its real path operand')
})

test('R5 fb-142: git commit -m "…(projected+reserve)/contextWindow…" is MESSAGE TEXT, not an absolute path', () => {
  assert.equal(deptExecDenyReason('git commit -m "(projected+reserve)/contextWindow"', CWD, ROOTS), undefined, 'the double-quoted commit message is allowed (fb-142 FP — the (/) boundaries extracted /contextWindow)')
  assert.equal(deptExecDenyReason("git commit -m '(projected+reserve)/contextWindow'", CWD, ROOTS), undefined, 'the single-quoted commit message is allowed too')
  assert.equal(deptExecDenyReason('git commit --message "(projected+reserve)/contextWindow"', CWD, ROOTS), undefined, '--message joins the message-flag family')
  assert.match(deptExecDenyReason('git add /etc/passwd', CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'a REAL git path OPERAND (git add /etc/passwd) is still denied — only the -m message span is skipped')
  assert.equal(deptExecDenyReason('git add /home/esuarez/projects/README.md', CWD, ROOTS), undefined, 'an IN-ROOT git operand is still allowed')
  assert.match(deptExecDenyReason('git commit -m "msg" /etc/passwd', CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'a REAL path OUTSIDE the -m message span is still denied')
})

test('R5 fb-135 (deny-side): a DENIED missing /packages/<name> token gains the discovery hint; non-packages denies stay byte-identical', () => {
  assert.equal(deptExecDenyReason('cat /home/esuarez/projects/deepartments/packages/dsh-key-pooler/x', CWD, ROOTS), undefined, 'an IN-ROOT missing packages path is not DENIED by the guard — it runs and fails (the fail-side hint below)')
  const deny = deptExecDenyReason('cat /etc/packages/dsh-key-pooler/x2', CWD, ['/home/esuarez/projects', '/usr/lib/node_modules/@deepseek-ai/dsh', '/srv/dept-ws'])
  assert.match(String(deny), /references absolute path "\/etc\/packages\/dsh-key-pooler\/x2"/, 'an OUT-OF-ROOT packages path is STILL denied (the containment is unchanged)')
  assert.match(String(deny), /no existe/, 'the deny carries the missing-path discovery hint')
  assert.match(String(deny), /usa glob para listar packages/, 'the hint suggests listing the real packages')
  // A non-packages deny keeps its exact phrase (no appended hint).
  const plain = deptExecDenyReason('cat /etc/passwd', CWD, ROOTS)
  assert.equal(plain, 'OUT_OF_SCOPE / DENIED — command references absolute path "/etc/passwd" outside a scoped dept_exec root (escalate via the Asistente / owner approval)', 'non-packages denies are byte-identical (no hint)')
})

test('R5 fb-214 (the "/" class): an awk/grep regex literal with ESCAPED slashes inside a quoted pattern is CONTENT, never an absolute path — the q-i-93 ledger count `awk \'/"https:\\/\\//\'` (a read-only awk match-regex whose escaped `\/` separators made the token look like `/https…`) is ALLOWED; the escaped-slash discriminator joins the fb-84 regex-literal family EXACTLY (a real multi-segment path has no backslash and keeps denying)', () => {
  // The recorded q-i-93 shape (regex with escaped content slashes) — ALLOWED.
  assert.equal(deptExecDenyReason("awk '/\"https:\\/\\//' /.deepartments/feedback.jsonl", CWD, [...ROOTS, '/.deepartments']), undefined, 'the fb-214 awk DOUBLE-Q escaped-slash regex is allowed (the `\\/` pairs are regex escapes, never separators)')
  assert.equal(deptExecDenyReason("awk '/https:\\/\\//' /.deepartments/feedback.jsonl", CWD, [...ROOTS, '/.deepartments']), undefined, 'the plain escaped-slash regex form is allowed too')
  assert.equal(deptExecDenyReason("grep -c '/https:\\/\\//' /.deepartments/feedback.jsonl", CWD, [...ROOTS, '/.deepartments']), undefined, 'the grep quoted escaped-slash pattern is a regex literal, not a path')
  assert.equal(deptExecDenyReason("awk -F'/' '/\"https:\\\\/\\\\// {c++} END {print c}' /.deepartments/feedback.jsonl", CWD, [...ROOTS, '/.deepartments']), undefined, 'the awk -F/ variant with escaped slashes stays allowed (the -F argument is a literal too)')
  // Control — a REAL multi-segment path (quoted or not) STILL denies: a path
  // word carries no backslash, so the escape discriminator never masks it.
  assert.match(deptExecDenyReason("grep -n '/etc/passwd' README.md", CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'a quoted MULTI-SEGMENT real path is STILL denied (the fb-84 control — no backslash, no escape)')
  assert.match(deptExecDenyReason('cat /etc/passwd', CWD, ROOTS), /references absolute path "\/etc\/passwd"/, 'an out-of-root real path is STILL denied')
})

test('R5 fb-214 (the "halt" class): a QUOTED denylist word and a PATH-SEGMENT/FILENAME named "halt" are CONTENT/FILE references, NEVER the command — `grep -i \'halt\' ledger`, `cat ./halt`, `ls /root/halt` and an in-root `/…/halt/…` path are ALLOWED; a REAL unquoted `halt` command word and the out-of-root protected paths STAY denied', () => {
  // The live fb-214 repro (my own read-only grep of the ledger was DENIED) —
  // a quoted pattern word is CONTENT, never a command.
  assert.equal(deptExecDenyReason("grep -i 'halt' /.deepartments/feedback.jsonl", CWD, [...ROOTS, '/.deepartments']), undefined, 'a QUOTED grep pattern "halt" is allowed (content — the fb-214 read-only grep; the boundary matcher previously denied the whole word in quotes)')
  assert.equal(deptExecDenyReason('echo "halt"', CWD, ROOTS), undefined, 'a quoted echo literal "halt" is text, never a command')
  // Filename / path-segment references.
  assert.equal(deptExecDenyReason('cat ./halt', CWD, ROOTS), undefined, 'a cwd-relative FILE named halt is allowed (a filename, not the command)')
  assert.equal(deptExecDenyReason('ls /home/esuarez/projects/deepartments/halt', CWD, ROOTS), undefined, 'an in-root directory named halt is allowed (a path segment, not the command)')
  assert.equal(deptExecDenyReason('cat /home/esuarez/projects/deepartments/halt/README.md', CWD, ROOTS), undefined, 'an in-root path through a halt segment is allowed')
  // REAL commands / operands STAY denied (the conservative ambiguity rule).
  assert.match(deptExecDenyReason('halt now', CWD, ROOTS), /denied token "halt"/, 'a REAL unquoted halt command is STILL denied')
  assert.match(deptExecDenyReason('cat halt', CWD, ROOTS), /denied token "halt"/, 'a bare unquoted halt operand is STILL denied (unresolvable ambiguity — conservative)')
  assert.match(deptExecDenyReason('cat /sbin/halt', CWD, ROOTS), /references absolute path "\/sbin\/halt"/, 'an out-of-root path THROUGH a halt segment is STILL denied (the abs-path scope closes the path hole the denylist skip opened)')
  // The rest of the denylist + controls unchanged.
  assert.match(deptExecDenyReason('sudo ls', CWD, ROOTS), /denied token "sudo"/, 'sudo is STILL denied')
  assert.equal(deptExecDenyReason("grep -n 'haltedAt' src/x.ts", CWD, ROOTS), undefined, 'the fb-109 halt-identifier case is STILL allowed')
})

// ---------------------------------------------------------------------------
// E2 (real Loader — the smokeBoot pattern): the fb-88/114 memo validator on
// the REAL head own-layer dept_memo_write (the strict registration) + the
// fb-135 FAIL-side hint through the REAL dept_exec tool.
// ---------------------------------------------------------------------------

/** Stub webServer/webRuntime/connection so the bundle's RPC mount effect runs
 * (the smoke-boot pattern — the client-graph server half). */
class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) { this.routes.push(route); return () => {} }
}
class StubWebRuntime extends Service {
  constructor(ctx) { super(ctx, 'webRuntime'); this.trustedHosts = [] }
}
class StubConnection extends Service {
  constructor(ctx) { super(ctx, 'connection'); this.trustedHosts = [] }
}

/** An agents service that MATERIALIZES a REAL scoped cordis child context and
 * RUNS the postSetup setup closure, so installHeadBoardTools actually executes
 * and its registration lands on the post's OWN tool layer. */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.store = new Map()
    this.childContexts = []
    this.createCalls = []
    this.scopeAnchor = ctx
  }
  get(id) { return this.store.get(String(id)) }
  list() { return [...this.store.values()] }
  roots() { return [...this.store.values()] }
  async create(options) {
    this.createCalls.push(options)
    const sessionId = String(options.sessionId)
    const agent = {
      id: sessionId,
      status: 'running',
      ctx: undefined,
      session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } },
      followup() {},
      cancel() {},
      async whenIdle() {}
    }
    const childKey = Symbol('stub-child-scope')
    const scope = createScope(this.scopeAnchor, childKey)
    const childCtx = scope.ctx.extend({ agent })
    agent.ctx = childCtx
    this.childContexts.push({ ctx: childCtx, key: childKey, agent })
    const provision = await options.setup?.(childCtx)
    provision?.commit?.()
    this.store.set(sessionId, agent)
    return { agent, dispose: async () => { this.store.delete(sessionId) } }
  }
  async resume(options) {
    return this.create({ ...options, sessionId: options.resumeSessionId })
  }
}

/** The REAL Loader composition of the dev-profile subset (dshd-core + the 6 P1
 * packages + dshd-orchestration + the bundle, in order) — the smokeBoot
 * pattern of the tools-factory test (hermetic temp stateDir). */
async function smokeBoot(stateDir, { org = { departments: [] }, agents = false } = {}) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  new StubWebServer(root)
  new StubWebRuntime(root)
  new StubConnection(root)
  if (agents === true) new StubAgents(root)
  loader.create({ id: 'dshd-core', name: 'dshd-core', config: { stateDir, org } })
  for (const id of ['dshd-feedback', 'dshd-quality', 'dshd-pooler', 'dshd-jobs', 'dshd-health', 'dshd-gui']) {
    loader.create({ id, name: id, config: {} })
  }
  loader.create({ id: 'dshd-orchestration', name: 'dshd-orchestration', config: {} })
  loader.create({ id: 'deepartments', name: '../lib/index.js', config: { stateDir, org } })
  await loader.await()
  const agentsStub = root.get('agents')
  if (agentsStub !== undefined) {
    agentsStub.scopeAnchor = loader.resolve('tools').fiber?.ctx ?? root
  }
  const pluginCtx = () => loader.resolve('deepartments').fiber?.ctx ?? loader.resolve('deepartments').ctx
  return {
    root,
    loader,
    pluginCtx,
    agentsStub,
    webServer: root.get('webServer'),
    dispose: () => loaderFiber.dispose()
  }
}

/** The department the boot materializes (the REAL repo tree owns the roles). */
const DEPARTMENT = {
  id: 'internal-programming',
  name: 'Internal Programming',
  roomId: 'room-ipd',
  coordinator: { postId: 'internal-programming-head' }
}

/** The REAL builder role template declares `dept_exec` (the allowExec gate) and
 * is the role the round's own worker runs under. */
const BUILDER_ROLE_PATH = path.join(REPO_ROOT, 'presets', 'departments', 'internal-programming', 'builder.md')

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('R5 fb-88/fb-114 (real Loader): the head own-layer dept_memo_write now ENUMERATES missing AND unknown keys in ONE invalid-arguments message (the strict post registration)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r5-dx-'))
  const roleSnapshot = existsSync(BUILDER_ROLE_PATH) ? readFileSync(BUILDER_ROLE_PATH, 'utf8') : null
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      const ctx = pluginCtx()
      // The embedded BOOT WIRING materializes the head through the composed
      // bundle (ensureAllHeads → ensureHead → headSetup/postSetup →
      // installHeadBoardTools — the factory's own path).
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the composed boot materialized the head through the bundle (the E2 drives the REAL installHeadBoardTools)')
      const headToolsGet = (name) => headChild.ctx.tools.get(name, headChild.key)
      assert.ok(headToolsGet('dept_memo_write') !== void 0, 'the head own-layer carries dept_memo_write (the memo own-layer insert)')

      const memoTool = headToolsGet('dept_memo_write')
      const agent = headChild.agent
      // THE RECORDED FP (fb-88): the IPH call with invented STRING keys instead
      // of the schema — the terse error used to be ONLY 'missing required
      // property "summary"'. The strict schema now enumerates BOTH.
      await assert.rejects(
        () => memoTool.execute({ currentStep: 'x', decisions: ['d'], 'explore-deep: …': 'z', 'Salto rc.1 …': 'w', openItems: ['o'] }, { agent }),
        (error) => {
          const msg = String(error?.message ?? error)
          assert.match(msg, /missing required property "summary"/, 'the missing required field is named')
          assert.match(msg, /"explore-deep: …" is not a declared property \(additionalProperties: false\)/, 'the FIRST invented key is named')
          assert.match(msg, /"Salto rc.1 …" is not a declared property \(additionalProperties: false\)/, 'the SECOND invented key is named')
          return true
        },
        'the fb-88 payload rejects with the full enumeration (missing + unknown keys in ONE message)'
      )
      // fb-114: the QH case — summary omitted (the other 4 keys present) still
      // names the missing field AND any unknown key in the same rejection.
      await assert.rejects(
        () => memoTool.execute({ constraints: ['c'], currentStep: 'x', decisions: ['d'], openItems: ['o'] }, { agent }),
        /missing required property "summary"/,
        'fb-114: an omitted summary keeps rejecting (the missing field named)'
      )
      // The valid call is UNCHANGED (the 5 declared keys pass the strict schema).
      const ok = await memoTool.execute({ summary: 'r5-e2-memo', decisions: [], constraints: [], openItems: [], currentStep: 'verify' }, { agent })
      assert.ok(ok !== null && typeof ok === 'object' && typeof ok.memoPath === 'string', 'a VALID dept_memo_write still returns the memoPath (the strict schema is not a regression)')
      assert.ok(existsSync(path.join(stateDir, 'journals', 'internal-programming-head.md')), 'the REAL journal file exists at <stateDir>/journals/<memberId>.md')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    if (roleSnapshot === null) await rm(BUILDER_ROLE_PATH, { force: true })
    else await writeFileSync(BUILDER_ROLE_PATH, roleSnapshot, 'utf8')
  }
})

test('R5 fb-216/fb-223 (real Loader): dept_memo_write now emits the ORG validator message — ONE error enumerating EVERY violation (missing required + wrong types + undeclared keys) PLUS the expected-fields list — on BOTH the head own-layer AND the HOST plane (the fb-216 host datapoint: a call with a loose keys `decisions` STRING + invented keys only named the FIRST failure before); a malformed call NEVER reaches the journal write (zero side effects)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r5-dx-'))
  const roleSnapshot = existsSync(BUILDER_ROLE_PATH) ? readFileSync(BUILDER_ROLE_PATH, 'utf8') : null
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      const ctx = pluginCtx()
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the composed boot materialized the head')
      const memoTool = headChild.ctx.tools.get('dept_memo_write', headChild.key)
      const agent = headChild.agent
      // (1) The fb-216 EXACT shape — summary omitted AND `decisions` given as a
      // STRING ("claves sueltas en lugar de arrays") AND an invented key: the
      // message enumerates ALL of them + the expected fields.
      await assert.rejects(
        () => memoTool.execute({ decisions: 'SD', 'decsions': ['x'], currentStep: 42 }, { agent }),
        (error) => {
          const msg = String(error?.message ?? error)
          assert.match(msg, /missing required property "summary"/, 'the missing required field is named')
          assert.match(msg, /"decisions" must be an array of strings/, 'the malformed decisions TYPE is named (fb-216: not only the first failure)')
          assert.match(msg, /"decsions" is not a declared property \(additionalProperties: false\)/, 'the INVENTED key is named (the closed-set rule, org-enforced)')
          assert.match(msg, /"currentStep" must be a string/, 'the wrong currentStep type is named too')
          assert.match(msg, /expected fields: summary, decisions, constraints, openItems, currentStep/, 'the message lists the EXPECTED FIELDS (fb-223) in ONE error')
          return true
        },
        'fb-216: ONE error enumerates EVERY violation + the expected fields'
      )
      // (2) A VALID call still passes (the org validator is not a regression).
      const ok = await memoTool.execute({ summary: 'fb216-ok', decisions: ['d'], constraints: [], openItems: ['o'], currentStep: 'verify' }, { agent })
      assert.ok(typeof ok?.memoPath === 'string', 'a valid call still writes the journal')
      // (3) The HOST plane (the global dept_memo_write — the fb-216/223 host
      // datapoint class: the host composing the call in parallel): the SAME org
      // message (the single memoWriteTool definition carries the validator).
      const hostAgent = { id: `host-${Date.now()}`, status: 'idle', ctx: { get: () => undefined }, session: { events: [], get seq() { return this.events.length }, snapshotEvents() { return this.events }, requestHeader() { return undefined } } }
      await assert.rejects(
        () => ctx.tools.get('dept_memo_write').execute({ 'summary': 7, 'openItems': 'not-an-array' }, { agent: hostAgent }),
        (error) => {
          const msg = String(error?.message ?? error)
          assert.match(msg, /missing required property "summary"/, 'HOST plane: the missing summary is named (a NUMBER summary is not the required string)')
          assert.match(msg, /"openItems" must be an array of strings/, 'HOST plane: the malformed openItems type is named')
          assert.match(msg, /expected fields: summary, decisions, constraints, openItems, currentStep/, 'HOST plane: the expected-fields list rides the same message (fb-223)')
          return true
        },
        'the HOST-plane registration emits the same complete org message'
      )
      // (4) ZERO side effects: the journal of the head was NOT touched by the
      // malformed post-own-layer call (only the VALID call above wrote it).
      const journal = readFileSync(path.join(stateDir, 'journals', 'internal-programming-head.md'), 'utf8')
      assert.ok(journal.includes('fb216-ok') && !journal.includes('missing'), 'the malformed calls wrote NOTHING (the validator runs before the memo write)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    if (roleSnapshot === null) await rm(BUILDER_ROLE_PATH, { force: true })
    else await writeFileSync(BUILDER_ROLE_PATH, roleSnapshot, 'utf8')
  }
})

test('R5 fb-209a (real Loader): dept_repo_state — the READ-ONLY git-state HEAD tool — runs through the REAL head own-layer and exposes the branch + upstream + the main..<branch> log + the working-tree diff stats + the worktrees of the deepartments repo, cap-bounded and FAIL-OPEN (a git failure returns the readable columns + `error`, never a crash); it NEVER writes (working-tree state unchanged after the call)', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r5-dx-'))
  const roleSnapshot = existsSync(BUILDER_ROLE_PATH) ? readFileSync(BUILDER_ROLE_PATH, 'utf8') : null
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      const ctx = pluginCtx()
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the composed boot materialized the head')
      const repoStateTool = headChild.ctx.tools.get('dept_repo_state', headChild.key)
      assert.ok(repoStateTool !== void 0, 'the head own-layer carries dept_repo_state (the head-only git-state tool)')
      // Snapshot the git state BEFORE (read-only verification: the tool never
      // writes — the exact worktree bytes must be unchanged after the call).
      const before = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
      const result = await repoStateTool.execute({}, { agent: headChild.agent })
      const after = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
      assert.equal(after, before, 'dept_repo_state NEVER writes the repo (a read-only tool — the AGENTS.md bytes are unchanged)')
      assert.equal(result.repo, REPO_ROOT, 'the tool reports the plugin repoRoot')
      assert.equal(result.branch, 'main', 'the repo is on main (the ceremony state) — the branch probe parses `git branch -vv`')
      assert.equal(typeof result.upstream, 'string', 'the upstream is exposed (origin/main)')
      assert.ok(Array.isArray(result.log), 'the log column is an array')
      assert.ok(Array.isArray(result.diffStats), 'the diff-stats column is an array')
      assert.ok(Array.isArray(result.worktrees) && result.worktrees.length >= 1, 'the worktree list is non-empty (the main worktree)')
      assert.equal(result.worktrees[0].includes(REPO_ROOT), true, 'the first worktree is the main repo path')
      // The diff-stats column reflects the CURRENT working tree (the merged
      // head-tooling lanes show as uncommitted files — the ceremony fact).
      assert.ok(result.diffStats.length >= 1, 'the diff stats carry the uncommitted ceremony state')
      // The host plane does NOT see it (the head-only manager gate).
      const hostTools = ctx.tools.get('dept_repo_state')
      assert.equal(hostTools, undefined, 'dept_repo_state is NOT exposed on the host/global plane (the head own-layer manager gate)')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    if (roleSnapshot === null) await rm(BUILDER_ROLE_PATH, { force: true })
    else await writeFileSync(BUILDER_ROLE_PATH, roleSnapshot, 'utf8')
  }
})

test('R5 fb-135 (real Loader): a FAILED dept_exec run whose command references a missing /packages/<name> path carries the discovery hint in the result stderr', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'deepartments-r5-dx-'))
  const roleSnapshot = existsSync(BUILDER_ROLE_PATH) ? readFileSync(BUILDER_ROLE_PATH, 'utf8') : null
  try {
    const { pluginCtx, agentsStub, dispose } = await smokeBoot(stateDir, { org: { departments: [DEPARTMENT] }, agents: true })
    try {
      const ctx = pluginCtx()
      // Materialize the head (the composed bundle's own path) — find it as the
      // tools-factory E2 does.
      let headChild
      for (let i = 0; i < 160; i++) {
        headChild = agentsStub.childContexts.find((c) => c.agent.id.includes('head-internal-programming-head'))
        if (headChild !== undefined) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(headChild !== undefined, 'the boot materialized the head (the E2 requires the REAL installHeadBoardTools)')
      // The SAFE snapshot-only variant: use a NON-EXISTENT package path that is
      // IN-ROOT (the real dsh-key-pooler typo vs dshd-pooler — fb-135's exact
      // case). This avoids side effects: the paths probed live under the repo
      // packages/ dir and are not touched, only read-stat'd by the hint.
      const missingPkg = path.join(REPO_ROOT, 'packages', 'dsh-key-pooler')
      assert.equal(existsSync(missingPkg), false, 'the typo target does not exist on disk (no side effect probed)')
      // The guard ALLOWS an in-root path (undefined); the FAILURE surfaces in
      // the RUN — that is where the fb-135 hint must land. Drive the pure
      // guard + the fail-side hint logic directly through the REAL dept_exec
      // tool of a worker whose role declares dept_exec.
      // (The head does NOT carry dept_exec — the allowExec gate — so spawn the
      // REAL builder role via the head's dept_worker_spawn, exactly the B2
      // recipe of invoke.test.js.)
      const signal = new AbortController().signal
      assert.equal(deptExecDenyReason(`cat ${missingPkg}/x`, CWD, ROOTS), undefined, 'the in-root missing package path is NOT denied by the guard (the tool runs and fails)')
      const spawnTool = headChild.ctx.tools.get('dept_worker_spawn', headChild.key)
      assert.ok(spawnTool !== void 0, 'the head own-layer carries dept_worker_spawn (the manager gate)')
      const spawnRes = await spawnTool.execute(
        { role: 'builder', task: 'r5 fb-135 e2' },
        { agent: headChild.agent, signal }
      )
      assert.ok(spawnRes !== null && typeof spawnRes === 'object' && typeof spawnRes.sessionId === 'string', 'dept_worker_spawn returned the worker session')
      const workerSid = String(spawnRes.sessionId)
      await waitFor(() => agentsStub.store.has(workerSid), 8000, 'the builder worker is live')
      const worker = agentsStub.store.get(workerSid)
      const workerChild = agentsStub.childContexts.find((c) => c.agent.id === workerSid)
      assert.ok(workerChild !== undefined && worker !== undefined, 'the worker context materialized')
      const execTool = workerChild.ctx.tools.get('dept_exec', workerChild.key)
      assert.ok(execTool !== void 0, 'the builder role declares dept_exec (the allowExec gate opens for the worker)')
      // The FAILED run: the command references the missing package path (in
      // root → guard passes → the shell fails). The result stderr must carry
      // the fb-135 discovery hint, not a bare io error.
      const result = await execTool.execute({ command: `cat ${missingPkg}/x` }, { agent: worker, signal })
      assert.equal(result.ok, false, 'the command fails (the typo path does not exist)')
      assert.match(result.stderr, /packages\/dsh-key-pooler/, 'the failed run names the missing package path')
      assert.match(result.stderr, /no existe/, 'the fb-135 discovery hint lands in the failed result stderr')
      assert.match(result.stderr, /usa glob para listar packages/, 'the hint suggests listing the real packages dir')
    } finally {
      dispose()
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    if (roleSnapshot === null) await rm(BUILDER_ROLE_PATH, { force: true })
    else await writeFileSync(BUILDER_ROLE_PATH, roleSnapshot, 'utf8')
  }
})