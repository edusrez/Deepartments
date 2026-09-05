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