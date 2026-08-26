// dshd-core — the DOMAIN role-orient subset extracted into this package
// (Fase-1 modular split). FASE 2.5 BATCH A: the bundle's `src/core/wakepack.ts`
// (moved here) depends on `buildSubagentOrientation`, `SubagentRole` and
// `ROLE_CONTRACTS` so it can build the subagent-orientation message. This module
// is that surface's within-package home, and is currently BYTE-IDENTICAL to the
// bundle's `src/role-orient.ts` (the bundle's live `roleRegistry` Map and the
// bundle-only `normalizeRole`/`rememberRole`/`forgetRole`/`roleForSession`
// helpers are NOT moved in Batch A — see the role-orient "do NOT touch" note).
// A single source of truth is consolidated in a later batch; until then both
// copies must be kept in sync by hand.
//
// NO export default (pitfall 0001).

export type SubagentRole = 'builder' | 'reviewer' | 'researcher' | 'scribe' | 'explore' | 'generic'

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
