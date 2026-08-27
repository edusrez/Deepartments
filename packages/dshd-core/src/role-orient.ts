// dsh-deepartments — ROLE-FOCUSED context orientation for TRANSIENT subagents
// (Task T4, 2026-08-21), promoted to a CORE SERVICE (D3 of the
// subagent/gui/pooler phase): the dispatch-time role registry + the per-role
// context contracts now live HERE as the `deepartments.subagentRoles` service,
// eliminating the bundle's module-global mutable Map (AGENTS.md rule 4 — the
// wakepack pre-step and the subagent tool resolve the same single store).
//
// Every tool-dispatched subagent (the single `secretary` role — see VOCAB —
// via the `dsh-deepartments/subagent` plugin, toolName 'secretary') today
// receives the FULL host wake pack ~4.6-4.9k tokens: identity branded
// `host-<uuid> (role: host)`, journal path, board
// delta, roster, git, system state, ROADMAP tail, and the full
// deepartments-workflow skill body — nearly all irrelevant to a one-shot atomic
// task and misleading (role labelled "host").
//
// VOCAB (M2, owner decision 2026-08-28): the transient tool dispatches ONE
// read-only NON-CODE role — `secretary` — a personal helper (deployed by the
// HOST and by department HEADS through the same plugin, toolName 'secretary')
// that reads journals/files/reports, searches (glob/grep) and summarises; it
// never edits, writes, or runs commands (internal code work always belongs to
// the IPD). The pre-M2 transient roles builder/reviewer/scribe/researcher
// (HOST-dispatched NON-CODE/emergency subagents — F3 vocabulary) are
// R6-DEPRECATED and UNIFIED into 'secretary' (normalizeRole maps them — see
// below); 'explore' stays retired (F2). The IPD's workers with the SAME names
// (presets/departments/internal-programming/) are DEPARTMENT ROOT AGENTS — a
// different class (dept_worker_spawn; never the subagent tool). Shared names
// are vocabulary, not identity; never conflate a transient subagent with an
// IPD worker.
//
// This module is the SINGLE SOURCE OF TRUTH for the role contract blocks injected
// instead. The per-role contracts below are distilled from the repo-tracked
// skill (`.dsh/skills/deepartments-workflow/SKILL.md`) "Dispatch templates":
// hard, role-defining, AGENTS.md-consistent. Those two surfaces are COMPLEMENTARY,
// not byte-identical: the SKILL.md light dispatch templates are the HANDOFF
// contract (Objective / Files in scope / Spec / Verification) written by the
// Asistente in the dispatch prompt, while ROLE_CONTRACTS here are the injected
// DISCIPLINE rules the child follows. They are kept consistent-by-design — a
// divergence would send the child mixed instructions — so a change to a role's
// contract here should be mirrored in the skill wording (and vice versa). Keep
// them SHORT: the whole point is LOW prompt weight.
//
// SINGLE STORE PER PROCESS (the «no double-register» invariant, D3): the
// registry Map is a MODULE-SCOPED binding OF THIS PACKAGE — ONE store per
// process, NEVER one per plugin/apply. The `deepartments.subagentRoles` service
// facade (provided eagerly by dshd-core's `apply`), the drop-in compat
// functions (`rememberRole` / `forgetRole` / `roleForSession`) the bundle
// bridge re-exports, and every in-process consumer (bundle fallback, real
// Loader tests seeding via lib/role-orient.js) all operate on THE SAME Map, so
// a role written by `src/subagent.ts` and read by the wakepack pre-step can
// never split across two registries (a split would silently degrade every
// subagent to `generic` — the slim-block regression the T4 tests catch). The
// R6 fallback path when dshd-core is NOT composed is behavior-neutral by
// construction: the bridge functions ARE the service semantics over the same
// store.
//
// NO export default (pitfall 0001).

export type SubagentRole = 'secretary' | 'generic'

const KNOWN_ROLES: readonly SubagentRole[] = ['secretary', 'generic']

/**
 * Normalize an arbitrary dispatch `role` value to a known {@link SubagentRole}.
 * M2 (owner decision 2026-08-28): the transient surface is UNIFIED into ONE
 * read-only NON-CODE contract — `'secretary'` — so the pre-M2 transient roles
 * `builder`/`reviewer`/`scribe`/`researcher` are R6-DEPRECATED and normalize
 * **to `'secretary'`** (a legacy dispatch still works, but with the
 * secretary's read-only contract instead of the old per-role one). `'explore'`
 * stays RETIRED (F2/F3) with an explicit rule here. Unknown/empty/undefined
 * values fall back to `'generic'` (the robust default, and also what a
 * cold-resumed continuable child gets when the in-process dispatch-time
 * registry (below) no longer holds its role).
 */
export function normalizeRole(role: unknown): SubagentRole {
  if (typeof role === 'string') {
    // M2: the ONE read-only NON-CODE transient contract.
    if (role === 'secretary') return 'secretary'
    // R6 — deprecated pre-M2 transient roles, UNIFIED into the secretary
    // (builder/reviewer/scribe/researcher were host-dispatched NON-CODE/
    // emergency subagents; the IPD's department WORKERS with the same names
    // are a different class — dept_worker_spawn — never the subagent tool).
    if (role === 'builder' || role === 'reviewer' || role === 'scribe' || role === 'researcher') return 'secretary'
  }
  // 'explore' (retired F2/F3) + unknown/empty/undefined → generic: deep code
  // analysis is the IPD `explore-deep` worker (presets/departments/
  // internal-programming/explore-deep.md), deployed ONLY by
  // internal-programming-head — never a host subagent.
  return 'generic'
}

/**
 * Dispatch-time role registry: `childSessionId → role`, written by
 * `subagent.ts` `execute` at dispatch and read by the pre-step injector in
 * `invoke.ts`. Keyed by the child's durable session id so it survives the
 * child's full (possibly multi-turn) life.
 *
 * WHY a single in-process Map rather than a field on the session header or agent
 * options: the child session's durable `meta` is a STRICTLY-typed record that
 * only forwards cwd/parentSession/seedLength/origin/delegationDepth/agentPreset
 * (dsh-session detaches+forwards the whitelist — verified lib/index.js:1658-1663),
 * so an arbitrary `meta.role` would be silently dropped; and `AgentOptions` is
 * strictly `{ provider?, model?, maxTokens? }` (dsh-agent runtime-types.d.ts:21),
 * so `agentOptions` cannot carry it either. The Map is the cleanest supported
 * channel: the writer (subagent.ts) and the reader (wakepack pre-step) are
 * modules of the same bundle running in one process, and dispatch eagerly
 * precedes the child's first pre-step. Cold-resume of a continuable child across
 * a restart loses only the ROLE (no registry entry) → defaults to `generic`; the
 * subagent `origin` is durable in the session meta, so it still gets the slim
 * role-oriented block, never the full host pack.
 *
 * D3 PROMOTION: the Map MOVED from the bundle's module scope to THIS package's
 * module scope, and the LIVE state is owned by the `deepartments.subagentRoles`
 * SERVICE facade below (`createSubagentRolesService`). The module-scoped binding
 * is the sanctioned singleton-per-process backing store (the service must
 * guarantee ONE registry per process — a Map per plugin/apply would let the
 * writer and the reader diverge). The bare `roleRegistry` export is kept ONLY
 * as the R6 drop-in superset of the old bundle surface (nothing reads it
 * directly); every WRITE/READ goes through the service surface or its compat
 * aliases, never by mutating the Map by hand.
 *
 * LIFECYCLE (keeps the map bounded by in-flight children — no unbounded global
 * mutable state, per AGENTS.md rule 4): a session id is WRITTEN once at dispatch
 * (`rememberRole`/`service.set` from subagent.ts `execute`), READ once at the
 * child's first pre-step (`roleForSession`/`service.get` from invoke.ts), and
 * EVICTED when the child settles (`forgetRole`/`service.delete` from the
 * `subagent/end` listener in subagent.ts). Because every entry is removed on
 * settlement, the map never grows past the set of children currently
 * dispatched-but-not-yet-settled in this process.
 */
export const roleRegistry = new Map<string, SubagentRole>()

/**
 * The `deepartments.subagentRoles` service surface — the dispatch-time
 * transient-subagent role registry, promoted from the bundle's module-global
 * Map into a core service (D3). Map-shaped (`get`/`set`/`delete`/`entries`)
 * with the T4 semantics preserved: `set` normalizes (unknown roles fall back to
 * `generic`), `delete` is a silent no-op for missing keys (superset of
 * `rememberRole`, safe at the `subagent/end` lifecycle edge), `get` returns
 * `undefined` for an unknown session (consumers apply `?? 'generic'` for the
 * `roleForSession` semantics).
 */
export interface SubagentRolesService {
  /** Resolve the dispatch-time role for a session id, or `undefined` when the
   * session has none (cold-resume / never-recorded). */
  get(sessionId: string): SubagentRole | undefined
  /** Record the dispatch-time role for a child session id (called once at
   * spawn; unknown values normalize to `generic` — the `rememberRole`
   * semantics). */
  set(childSessionId: string, role: unknown): void
  /** Evict the dispatch-time role for a child session id (called once at child
   * settlement; deleting a missing key is a silent no-op — the `forgetRole`
   * semantics). */
  delete(childSessionId: string): void
  /** Iterate the live entries (`childSessionId → role`) — bounded by in-flight
   * children (every entry is evicted at settlement). */
  entries(): IterableIterator<[string, SubagentRole]>
}

/** The single per-process service instance (module-scoped singleton: every
 * `createSubagentRolesService()` call returns the SAME facade over the same
 * store, so bundle, core and tests can never hold two registries). */
let serviceInstance: SubagentRolesService | undefined

/** Create (or return the existing) `deepartments.subagentRoles` service facade
 * over the SINGLE per-process role registry. dshd-core's `apply` provides this
 * eagerly (no late-binding needed — the service is self-contained); consumers
 * in a minimal composition (dshd-core absent) fall back to the drop-in compat
 * functions below, which run the SAME service semantics over the SAME store
 * (R6 — behavior-neutral). */
export function createSubagentRolesService(): SubagentRolesService {
  return (serviceInstance ??= {
    get: (sessionId) => roleRegistry.get(sessionId),
    set: (childSessionId, role) => { roleRegistry.set(childSessionId, normalizeRole(role)) },
    delete: (childSessionId) => { roleRegistry.delete(childSessionId) },
    entries: () => roleRegistry.entries()
  })
}

/** Record the dispatch-time role for a child session id (called once at spawn).
 * R6 drop-in alias of `service.set` (same store) — the bundle and the tests
 * keep importing this from lib/role-orient.js. */
export function rememberRole(childSessionId: string, role: unknown): void {
  createSubagentRolesService().set(childSessionId, role)
}

/**
 * Evict the dispatch-time role for a child session id (called once at child
 * settlement). A superset of `rememberRole`: writing the same key twice just
 * overwrites, and deleting a missing key is a silent no-op — so this call is
 * safe to run unconditionally at the `subagent/end` lifecycle edge. R6 drop-in
 * alias of `service.delete` (same store).
 */
export function forgetRole(childSessionId: string): void {
  createSubagentRolesService().delete(childSessionId)
}

/** Resolve the role for a session id, defaulting to `generic` when unknown.
 * R6 drop-in alias of `service.get` + the generic default (same store). */
export function roleForSession(sessionId: string): SubagentRole {
  return createSubagentRolesService().get(sessionId) ?? 'generic'
}

/**
 * Concise per-role contract blocks injected at the first `agent/pre-step` of a
 * transient subagent, replacing the ~4.6-4.9k-token full host pack. Distilled,
 * hard, AGENTS.md-consistent. COMPLEMENTARY to (NOT byte-consistent with) the
 * repo skill's light dispatch templates: those are the handoff contract
 * (Objective/Files/Spec/Verification) written in the dispatch prompt, these are
 * the injected discipline rules — consistent-by-design, not identical.
 */
export const ROLE_CONTRACTS: Record<SubagentRole, string> = {
  secretary:
    '- READ-ONLY NON-CODE: you READ files, reports and journals and you SEARCH (glob/grep) to SUMMARISE for the agent that deployed you — you never write, edit, run commands, or deploy anything.\n' +
    '- FOCUS: read and summarise only what the deployer asked for (e.g. "read my journal and summarise the open items", "review the report at <path>").\n' +
    '- CODE BELONGS TO THE IPD: any internal programming or deep code analysis is NEVER attempted here — state the limitation instead (the deployer routes it to internal-programming-head via send_message).\n' +
    '- REPORT: a concise self-contained summary to the agent that deployed you (it does not see your transcript).',

  // R6 — DEPRECATED pre-M2 transient roles (M2, owner decision 2026-08-28):
  // builder/reviewer/scribe/researcher are no longer SubagentRole members;
  // normalizeRole maps them → 'secretary' (the ONE read-only NON-CODE
  // contract). The IPD's department WORKERS with the same names
  // (presets/departments/internal-programming/) are a different class —
  // dept_worker_spawn root agents, never the subagent tool. Former contracts,
  // kept verbatim for the record (pre-M2 repo history):
  //   builder:    make ONLY the specified changes; verify EXACTLY; never commit;
  //               follow AGENTS.md; report changed files + line refs. (Now the
  //               read-only secretary contract instead — code → IPD only.)
  //   reviewer:   READ-ONLY PASS/FAIL verdict over a diff scope (now subsumed
  //               by the secretary's read contract; verdicts → the deployer).
  //   researcher: WEB-FIRST research with web_search (now subsumed by the
  //               secretary; a host researcher subagent is NOT the normal path
  //               — D2 delegates research to research-head).
  //   scribe:     DRAFT-ONLY writes to .dsh/reports/scribe/ (now retired from
  //               the transient surface — the secretary never writes files;
  //               doc drafting that needs writes is department-owned work).
  //
  // R6 — RETIRED transient role (F2/F3, owner decision 2026-08-27): 'explore'
  // remains no longer a valid transient SubagentRole; normalizeRole('explore')
  // → 'generic'. Deep code analysis is the IPD `explore-deep` worker
  // (presets/departments/internal-programming/explore-deep.md), deployed ONLY
  // by internal-programming-head. Former contract, kept verbatim for the
  // record: READ-ONLY (no edits, no bash); TRACE the full flow (grep/glob +
  // reads, follow imports and callers, cross-refs, AGENTS.md check); REPORT IN
  // DEPTH to .dsh/reports/explore/<YYYY-MM-DD>-<task-slug>.md.

  generic:
    '- You are a delegated Deepartments subagent for a single atomic task.\n' +
    '- DO THE ONE TASK GIVEN in your dispatch prompt: objective, files in scope, spec/acceptance, verification.\n' +
    '- RESPECT SCOPE: only touch the listed files; if another must change, STOP and report.\n' +
    '- REACH FOR TOOLS: web_search/web_fetch for anything current (cutoff 2025); read/grep/glob for code.\n' +
    '- REPORT your result (the parent does not see your transcript).'
}

/** One-line org identity for the compact subagent injection. */
export function buildSubagentOrientation(role: SubagentRole, roomId: string): string {
  const reporting = role === 'secretary'
    ? 'Return the deployer a concise self-contained summary (they do not see your transcript).'
    : 'Write your report to `.dsh/reports/<role>/<YYYY-MM-DD>-<task-slug>.md` with the convention frontmatter; return the parent a concise self-contained summary referencing shared paths.'
  return [
    '## Deepartments context',
    'pack-v1: present',
    `- identity: Deepartments subagent (role: ${role}, room: ${roomId})`,
    '',
    '## Your role contract',
    ROLE_CONTRACTS[role],
    '',
    '## Reporting',
    reporting
  ].join('\n')
}