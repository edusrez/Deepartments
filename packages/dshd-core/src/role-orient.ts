// dsh-deepartments — ROLE-FOCUSED context orientation for TRANSIENT subagents
// (Task T4, 2026-08-21), promoted to a CORE SERVICE (D3 of the
// subagent/gui/pooler phase): the dispatch-time role registry + the per-role
// context contracts now live HERE as the `deepartments.subagentRoles` service,
// eliminating the bundle's module-global mutable Map (AGENTS.md rule 4 — the
// wakepack pre-step and the subagent tool resolve the same single store).
//
// Every tool-dispatched subagent (builder/reviewer/researcher/scribe/explore via
// `subagent`/`subagent_fork`) today receives the FULL host wake pack ~4.6-4.9k
// tokens: identity branded `host-<uuid> (role: host)`, journal path, board
// delta, roster, git, system state, ROADMAP tail, and the full
// deepartments-workflow skill body — nearly all irrelevant to a one-shot atomic
// task and misleading (role labelled "host").
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

export type SubagentRole = 'builder' | 'reviewer' | 'researcher' | 'scribe' | 'explore' | 'generic'

const KNOWN_ROLES: readonly SubagentRole[] = ['builder', 'reviewer', 'researcher', 'scribe', 'explore', 'generic']

/**
 * Normalize an arbitrary dispatch `role` value to a known {@link SubagentRole}.
 * Unknown/empty/undefined over and under-specified values all fall back to
 * `'generic'` (the robust default the audit recommends). The default is what a
 * cold-resumed continuable child also gets when the in-process dispatch-time
 * registry (below) no longer holds its role.
 */
export function normalizeRole(role: unknown): SubagentRole {
  if (typeof role === 'string' && (KNOWN_ROLES as readonly string[]).includes(role)) return role as SubagentRole
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
  builder:
    '- SCOPE DISCIPLINE: make ONLY the specified changes; flag, do not fix, adjacent problems.\n' +
    '- VERIFY BEFORE REPORTING: run the given verification command EXACTLY; iterate minimally until green; after 2 retries STOP and report (the Asistente escalates).\n' +
    '- NEVER COMMIT: the Asistente verifies and commits each batch.\n' +
    '- FOLLOW AGENTS.md: read it before editing; respect its invariants.\n' +
    '- REPORT: changed files + line refs, verification tail, spec deviations, escalate yes/no.',

  reviewer:
    '- READ-ONLY: you do NOT write or edit code.\n' +
    '- REVIEW ONLY the given diff scope; focused gate, not a full audit.\n' +
    '- CHECKLIST: spec conformance (no drive-by edits), AGENTS.md invariants, edge cases, concurrency hazards, test coverage.\n' +
    '- VERIFICATION HONESTY: is the reported output plausible? Be skeptical.\n' +
    '- VERDICT: PASS (1-2 line note) or FAIL (each failure file:line + one-line fix) — do NOT fix anything. Keep < ~30 lines.',

  researcher:
    '- WEB-FIRST: your training cutoff is 2025 — use web_search for anything current and RESPECT DATES.\n' +
    '- STRATEGY: start wide and narrow; vary queries (2-4 angles); read in parallel; prefer PRIMARY sources (official docs, GitHub); saturate after 3+ sources repeat.\n' +
    '- REPORT: full findings to .dsh/reports/researcher/<YYYY-MM-DD>-<topic>.md; return the Asistente ONLY a concise summary (3-5 bullets) + the report path.',

  scribe:
    '- DRAFT-ONLY: write to .dsh/reports/scribe/<YYYY-MM-DD>-<topic>.md ONLY — never into AGENTS.md, README.md, docs/ or any live doc.\n' +
    '- NEVER AUTO-COMMIT; never edit AGENTS.md (propose additions marked "PROPOSED for AGENTS.md:" and the human decides).\n' +
    '- You may READ live docs for context; no bash.\n' +
    '- RETURN: a 3-line summary — what you drafted, where, which proposals need a decision.',

  explore:
    '- READ-ONLY: no edits, no bash.\n' +
    '- TRACE the full flow: grep/glob + reads, follow imports and callers, cross-refs, check against AGENTS.md.\n' +
    '- REPORT IN DEPTH: flow/architecture summary, key files + file:line, patterns (good and bad), invariant status, surprises. Write to .dsh/reports/explore-deep/<YYYY-MM-DD>-<task-slug>.md.',

  generic:
    '- You are a delegated Deepartments subagent for a single atomic task.\n' +
    '- DO THE ONE TASK GIVEN in your dispatch prompt: objective, files in scope, spec/acceptance, verification.\n' +
    '- RESPECT SCOPE: only touch the listed files; if another must change, STOP and report.\n' +
    '- REACH FOR TOOLS: web_search/web_fetch for anything current (cutoff 2025); read/grep/glob for code.\n' +
    '- REPORT your result (the parent does not see your transcript).'
}

/** One-line org identity for the compact subagent injection. */
export function buildSubagentOrientation(role: SubagentRole, roomId: string): string {
  return [
    '## Deepartments context',
    'pack-v1: present',
    `- identity: Deepartments subagent (role: ${role}, room: ${roomId})`,
    '',
    '## Your role contract',
    ROLE_CONTRACTS[role],
    '',
    '## Reporting',
    'Write your report to `.dsh/reports/<role>/<YYYY-MM-DD>-<task-slug>.md` with the convention frontmatter; return the parent a concise self-contained summary referencing shared paths.'
  ].join('\n')
}