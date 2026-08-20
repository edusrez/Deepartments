// dsh-deepartments — PER-HEAD agent presets (Batch 4a). A configured department
// head is materialized as a NATIVE, openable session created from a per-head
// agent preset: one preset per department (`deepartments-head-<departmentId>`),
// derived from the generic `deepartments-head` base preset plus the department
// role, so it appears in the NATIVE "New session with..." picker
// (agentPreset.list scans `<DSH_HOME>/.agent-presets/`) and the head session's
// agentPreset header carries the per-head preset, so the UI labels the session
// with the head's title.
//
// This module is PURE and side-effect free (no I/O): it derives the preset id,
// display name, role line, and the two materialized file contents from config
// + the base composition text. The file-writing loop (mkdir / skip-on-identical
// / copy) lives in src/invoke.ts (`materializeHeadPreset`); the pure builds here
// are directly unit-testable via node --test (Rule 3b/4 in test/invoke.test.js:
// hermetic, no DSH_HOME, no LLM), mirroring how buildAgentRows is tested.
//
// Decision (owner 2026-08-20): the generic `presets/deepartments-head/` base is
// KEPT as the TEMPLATE and the generic fallback (a head whose department cannot
// be resolved — should not happen, since every configured head has one). The
// per-head composition is generated from the base text + a role line, so the
// neutral persona is a single source of truth and the per-head preset is
// self-identifying ("You are <title>, the head of the <department> department").
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { CoordinatorConfig } from './org.js'

/** The generic base head preset id (the template + fallback). */
export const HEAD_PRESET_BASE_ID = 'deepartments-head'

/** The stable per-head preset id for one department: `deepartments-head-<id>`. */
export function headPresetIdFor(departmentId: string): string {
  return `${HEAD_PRESET_BASE_ID}-${departmentId}`
}

/** The display-name core of a head preset: title → role → postId fallback. */
export function headPresetNameCore(coordinator: CoordinatorConfig): string {
  return coordinator.title || coordinator.role || coordinator.postId
}

/** The full display name: `${title} - Deepartments` (shown in the native picker). */
export function headPresetNameFor(coordinator: CoordinatorConfig): string {
  return `${headPresetNameCore(coordinator)} - Deepartments`
}

/**
 * The stable sentence injected into the base head persona, naming the head so
 * the per-head session is self-identifying. It becomes the FIRST sentence of
 * the generated composition's persona, e.g. `You are Head of Research, the
 * head of the "Research" department. You are a permanent department head...`.
 */
export function headRoleLine(headName: string, departmentName: string): string {
  return `${headName}, the head of the "${departmentName}" department`
}

/**
 * The exact, unique, stable anchor in the base `presets/deepartments-head/
 * agent.cordis.yml` persona whose FIRST occurrence the generator expands with
 * the per-head role line. Kept as a literal so a base-file refactor that moves
 * the sentence fails loudly (the builder returns the base unchanged rather than
 * emitting a malformed composition).
 */
export const HEAD_PERSONA_ANCHOR = 'You are a permanent department head in the Deepartments organization'

/**
 * Build the per-head `agent.cordis.yml` composition text: the base head
 * composition with the neutral persona's first sentence expanded to name the
 * head. Same neutral persona as the base, PLUS a department-role line. When the
 * anchor is absent (base refactor), returns the base unchanged — non-fatal and
 * deterministic.
 */
export function buildHeadPresetComposition(baseComposition: string, headName: string, departmentName: string): string {
  const roleLine = headRoleLine(headName, departmentName)
  const replacement = `You are ${roleLine}. ${HEAD_PERSONA_ANCHOR}`
  const idx = baseComposition.indexOf(HEAD_PERSONA_ANCHOR)
  if (idx === -1) return baseComposition
  return baseComposition.slice(0, idx) + replacement + baseComposition.slice(idx + HEAD_PERSONA_ANCHOR.length)
}

/**
 * Build the per-head `preset.yml` display metadata: `name: "<title> - Deepartments"`
 * so the native picker shows the head's title. Double-quoted YAML string keeps
 * the title safe for the common character set. `order` 30 sits after the shared
 * head/worker presets (20/21) in the default picker ordering.
 */
export function buildHeadPresetMetadata(name: string, order = 30): string {
  return [
    `name: "${name.replaceAll('"', '\\"')}"`,
    'description: Per-head agent preset for this Deepartments department head — a native, openable session created from the shared neutral head persona plus this department\u2019s role.',
    `order: ${order}`,
    ''
  ].join('\n')
}
