// dsh-deepartments — ROLE-FOCUSED context orientation for TRANSIENT subagents
// (Task T4, 2026-08-21).
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
// hard, role-defining, AGENTS.md-consistent. The skill's light dispatch templates
// reference these blocks ("your role contract is injected by Deepartments — follow
// it"), so a change to a role's contract here MUST stay byte-consistent with that
// skill text. Keep them SHORT: the whole point is LOW prompt weight.
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
 * WHY a module-level Map rather than a field on the session header or agent
 * options: the child session's durable `meta` is a STRICTLY-typed record that
 * only forwards cwd/parentSession/seedLength/origin/delegationDepth/agentPreset
 * (dsh-session detaches+forwards the whitelist — verified lib/index.js:1658-1663),
 * so an arbitrary `meta.role` would be silently dropped; and `AgentOptions` is
 * strictly `{ provider?, model?, maxTokens? }` (dsh-agent runtime-types.d.ts:21),
 * so `agentOptions` cannot carry it either. The Map is the cleanest supported
 * channel: both subagent.ts and invoke.ts are modules of the same bundle running
 * in one process, and dispatch eagerly precedes the child's first pre-step.
 * Cold-resume of a continuable child across a restart loses only the ROLE (no
 * registry entry) → defaults to `generic`; the subagent `origin` is durable in
 * the session meta, so it still gets the slim role-oriented block, never the
 * full host pack.
 */
export const roleRegistry = new Map<string, SubagentRole>()

/** Record the dispatch-time role for a child session id (called once at spawn). */
export function rememberRole(childSessionId: string, role: unknown): void {
  roleRegistry.set(childSessionId, normalizeRole(role))
}

/** Resolve the role for a session id, defaulting to `generic` when unknown. */
export function roleForSession(sessionId: string): SubagentRole {
  return roleRegistry.get(sessionId) ?? 'generic'
}

/**
 * Concise per-role contract blocks injected at the first `agent/pre-step` of a
 * transient subagent, replacing the ~4.6-4.9k-token full host pack. Distilled,
 * hard, AGENTS.md-consistent. Byte-consistent with the repo skill's light
 * dispatch templates.
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
