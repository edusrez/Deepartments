// dsh-deepartments — the WAKE CONTEXT PACK + ROSTER (the host wake injection).
//
// FASE 2 STEP (e): THIS module OWNS the wake-pack injector + roster carved out of
// the invoke.ts monolith. It is the SINGLE home of:
//   - the pure wake-pack builders (`buildWakePack`, `buildWakePackMessage`,
//     `WakePackParts`, `HOST_WAKE_ROUTINE_TEXT`, `HOST_WAKE_NEXT_STEP`,
//     `presenceGuidance`, `buildPresenceMessage`, `formatMessageDeltaLine`);
//   - the `buildCondensedRoster` (the condensed roster of the WHOLE catalog —
//     registered posts + non-retired hosts, with their durable REGISTRY
//     sleeping flags, NEVER live `sessionLive` liveness);
//   - the ASSEMBLY (`assembleWakePack` / `assembleWakeSnapshot`): the live
//     git/ROADMAP/skill/journal reads folded into the pure builder;
//   - the `agent/pre-step` INJECTOR (Batch C): the host-only, retired-gated,
//     once-per-session wake-pack injection at message-arrival time (and the
//     Task T4 transient-subagent role orientation).
//
// The same pattern as registry/delivery: the apply fiber constructs ONE
// `WakePackService` per-apply via `createWakePackService(deps)` with deps
// INJECTED (AGENTS.md rule 4 — NO module-global mutable state). The CLOSURE-
// BOUND primitives that stay deep in the invoke.ts plugin fiber (the deferred
// sleep surface replace, the health-heartbeat assembly, the presence cache
// refresh, the catalog identity resolvers, the role resolver) are injected as
// callbacks rather than relocated, so the module never holds a module-level
// mutable binding and never depends on invoke.ts.
//
// SINGLE-SOURCE ACTIVE-ONLY: the active-members filter ("non-retired posts +
// non-retired hosts") is NOT implemented here — `buildCondensedRoster` derives
// the live roster from `listActiveMembers` (src/core/registry.ts), the ONE
// implementation the future `dept_who`/registry will adopt. Nothing here
// re-implements the retired filter.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFile } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { createUserMessage, boundContextSummary, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { PostEntry, HostEntry } from './registry.js'
import { listActiveMembers } from './registry.js'
import type { MessageRecord } from './messages.js'
// D3 consolidation (subagent/gui/pooler phase): the transient-subagent role
// type's SINGLE SOURCE OF TRUTH is now THIS package's ./role-orient.js (the
// `deepartments.subagentRoles` service, promoted from the bundle's
// role-orient.ts — see FASE 2.5 BATCH B history below). The bundle consumes it
// through the drop-in bridge (src/role-orient.ts -> 'dshd-core'), so this
// module imports the type here instead of declaring a structural duplicate
// (same package, one declaration).
import type { SubagentRole } from './role-orient.js'

const execFileP = promisify(execFileCb)

/**
 * The transient-subagent role. ROLE-CONTRACTS CONSOLIDATION (FASE 2.5 BATCH B
 * + D3): the bundle `src/role-orient.ts` was the SINGLE SOURCE OF TRUTH and
 * this package did NOT own a role-orient copy — the runtime
 * `buildSubagentOrientation` was INJECTED via `WakePackDeps`. D3 promoted the
 * registry + role-orient surface INTO this package (`./role-orient.js`, the
 * `deepartments.subagentRoles` service), so this module now imports the type
 * from there (one declaration per package); the wake-pack DEP contract is
 * unchanged — `roleForSession` / `buildSubagentOrientation` are still injected
 * by the bundle (which resolves them to the same service store).
 *
 * NO export default (pitfall 0001 — breaks `inject`).
 */

// ---------------------------------------------------------------------------
// PURE wake-pack helpers (shared with the assembly; unit-tested via lib/invoke).
// ---------------------------------------------------------------------------

/** B3 cutover (spec 003 §7.2): the wake-pack message-delta section carries the
 * caller's LATEST-RECEIVED messages, capped small — the pack is injected every
 * wake turn, so the section must stay lean. */
export const WAKE_MESSAGE_DELTA_LIMIT = 5

/**
 * Format one message-store record as a compact TOC line for the model-facing
 * message delta (spec 003 §7.2 — the wake pack's message-delta section): the
 * record id + sender → recipients + a short preview. The preview is truncated
 * to 140 chars with an explicit '…' when longer — never silently shortened.
 */
export function formatMessageDeltaLine(message: Pick<MessageRecord, 'id' | 'from' | 'to' | 'text' | 'kind'>): string {
  const preview = message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text
  return `- ${message.id} | ${message.from} → ${message.to.join(', ') || '(all)'} | ${preview}`
}

/**
 * Project ANY value to a PLAIN JSON-safe value accepted by dsh-session's
 * `snapshotJsonValue` (the `agent/inbox/spliced` append boundary — W7-B): JSON
 * scalars, plain arrays, and plain/null-prototype objects ONLY. No branded /
 * class instances, functions, `undefined`, symbols, bigint, non-finite
 * numbers, sparse arrays, negative zero or circular references. A
 * non-plain/branded object degrades to its primitive string form (e.g. a
 * `SessionId`/`MessageId` brand → the bare string, `Date` → ISO, `RegExp` →
 * `/…/`); functions/`undefined`/symbols/bigint are OMITTED from objects (never
 * a present `undefined` key — `snapshotJsonValue` REJECTS a plain object whose
 * property value is `undefined`) and become `null` inside arrays; circular
 * references are cut to `null`. The bus UserMessage `source` (and the wake-pack
 * message) is run through this BEFORE it is inserted, so the spliced event is
 * ALWAYS serializable — a malformed/wrong value must NOT fail a delivery turn
 * (the seam keeps its never-throw contract). A top-level `undefined`/function
 * result is the "omit this key" signal for the caller. Never throws.
 */
export function toJsonSafe<T>(value: T): T {
  const seen = new WeakSet<object>()
  const visit = (v: unknown): unknown => {
    if (v === null) return null
    const t = typeof v
    if (t === 'string' || t === 'boolean') return v
    if (t === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : null
    // undefined / function / symbol / bigint are NOT JSON scalars → omit (object)
    // or null (array). A present `undefined` KEY is what broke the splice.
    if (t !== 'object') return undefined
    const obj = v as object
    if (seen.has(obj)) return null // circular ref → cut
    if (Array.isArray(obj)) {
      seen.add(obj)
      const out: unknown[] = []
      for (let i = 0; i < obj.length; i++) {
        // sparse holes and undefined/function elements → null (snapshotJsonValue
        // rejects both a missing own index and a non-scalar element).
        out.push(Object.prototype.hasOwnProperty.call(obj, i) ? (visit((obj as unknown[])[i]) ?? null) : null)
      }
      return out
    }
    seen.add(obj)
    const proto = Object.getPrototypeOf(obj)
    // Exotic / branded / class instance (not a plain object): if it has a
    // non-default string projection, use it (Date → ISO, RegExp → /…/, a brand
    // that runs `String(x)`); otherwise fall through to its own enumerable keys.
    if (proto !== Object.prototype && proto !== null) {
      const maybe = String(obj)
      if (typeof maybe === 'string' && maybe !== '[object Object]') return maybe
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      const item = visit((obj as Record<string, unknown>)[key])
      if (item !== undefined) out[key] = item
    }
    return out
  }
  // Generic: the projected value is shape-preserving (a plain JSON-safe clone),
  // so the compile-time type T stays valid for the caller's object-literal
  // inference (a fresh literal type is assignable to followup's
  // `Record<string, unknown>`, whereas a `MessageSource` interface is not).
  return visit(value) as T
}

/** Project any message `source` (a bus `AgentMessageSource` OR a wake-pack
 * plugin-notice source — both are `MessageSource` values) to a plain JSON-safe
 * value, keeping every semantically-important field as plain strings/arrays and
 * omitting any that are `undefined`. This is the emit-site sanitizer (W7-B). */
export function jsonSafeMessageSource<T extends MessageSource>(source: T): T {
  return toJsonSafe(source)
}

/** W8-b prompt-literal safety (delivery-seam brace sanitizer). The KNOWN-BOUND
 * template variable names used by persona/preset templating (spec 004 §9.1 /
 * F10 — see `renderDepartmentTemplate`): a reference to one of these MUST
 * survive so the persona/preset assembler can bind it. `cwd` is the legitimate
 * lowercase harness preset variable that renderDepartmentTemplate NEVER touches;
 * the other four are the department template variables it substitutes. */
/** The KNOWN-BOUND template-variable names used by persona/preset templating
 * (spec 004 §9.1 / F10 — see `renderDepartmentTemplate`): a reference to one of
 * these MUST survive so the persona/preset assembler can bind it. Exported so
 * the preset-audit scanner (invoke.ts `auditPresetText`) uses the SAME set that
 * `sanitizePromptLiterals` preserves. */
export const BOUND_TEMPLATE_VARS: ReadonlySet<string> = new Set([
  'cwd',
  'headPostId',
  'workspacePath',
  'reportDir',
  'deptName'
])

/** The break renderer for an UNBOUND double-brace template reference: the
 * two-opening-braces sequence is emitted as the two characters separated by a
 * space, so no complete opening brace-pair remains and the prompt assembler
 * sees no reference. A real prose space (not a zero-width span) is used because
 * it is never stripped by the prompt expander — the assembler only ever matches
 * a contiguous `{{`, and `{ {` is not one. */
const PROMPT_LITERAL_UNBOUND_BREAK = '{ {'

/**
 * W8-b prompt-literal safety (delivery-seam brace sanitizer). Returns a copy of
 * `text` in which every DOUBLE-BRACE TEMPLATE REFERENCE that is NOT one of the
 * known-bound template vars (cwd / headPostId / workspacePath / reportDir /
 * deptName) is BROKEN so the prompt assembler sees no reference — an unbound
 * double-brace token (two opening braces + a name + two closing braces, or a
 * bare two-opening-braces marker) is a FATAL malformed prompt-variable
 * reference that fails the recipient session assembly. A bound var reference is
 * LEFT UNCHANGED (it must survive for the persona/preset assembler to bind it).
 * Text WITHOUT any double-brace token is returned BYTE-IDENTICAL (no spurious
 * change). Pure, deterministic, never throws.
 */
export function sanitizePromptLiterals(text: string): string {
  // Fast path: no double-opening-brace marker anywhere → byte-identical.
  if (!text.includes('{{')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const ref = /^([a-zA-Z][a-zA-Z0-9_]*)}}/.exec(text.slice(i + 2))
      if (ref !== null && BOUND_TEMPLATE_VARS.has(ref[1])) {
        // Bound reference → leave the opening double-brace untouched; the name
        // and closing braces fall through the scan unchanged.
        out += '{{'
        i += 2
        continue
      }
      // Unbound name (or a bare two-opening-braces marker): break the opening
      // brace-pair so the assembler sees no reference (brace-safe).
      out += PROMPT_LITERAL_UNBOUND_BREAK
      i += 2
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/**
 * The owner-presence directive line, injected alongside the state in BOTH the
 * presence-change node (`buildPresenceMessage`, A4) and wake-pack section 2
 * (`buildWakePack`) so the host is told how to act on the CURRENT state.
 */
export function presenceGuidance(present: boolean): string {
  return present
    ? 'Owner guidance: make the most of the presence — share any question you have (none is fine — no need to force it) or report what was done while the owner was away.'
    : 'Owner guidance: work autonomously as far as you can; you will be notified when the owner returns.'
}

/**
 * Build the Deepartments wake context pack message, framed like the journal node
 * (`kind:'plugin' / form:'notice'` → collapsed notice row, NOT a user-typed
 * message, so `deriveMessages()` folds its content verbatim on the next turn).
 * Injected FRESH via `agent/pre-step` at message-arrival time by the host
 * pre-step injector (not frozen into the surface at dept_sleep), so its message
 * delta / git / roster / cursor are current when the user's message arrives.
 * Kept separate from `buildSleepJournalMessage` so the journal node stays
 * byte-identical; the pack gets its own notice summary.
 */
export function buildWakePackMessage(packText: string) {
  return createUserMessage({
    // W8-b prompt-literal safety: the wake-pack text (message-delta section,
    // roster, git, skill body) is run through the brace sanitizer so an unbound
    // double-brace token in a delivered message (or any assembled pack content)
    // can never break the recipient session assembly. Bound persona/preset vars
    // (cwd/headPostId/workspacePath/reportDir/deptName) are preserved.
    content: [{ type: 'text', text: sanitizePromptLiterals(packText) }],
    // W7-B: JSON-safe source projection (the wake-pack message is inserted into
    // a durable session; a branded/non-plain value would break the splice).
    source: jsonSafeMessageSource({
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Deepartments wake context pack — injected orientation (identity, journal path, message delta, roster, git, system state, full deepartments-workflow skill).')
    })
  })
}

/**
 * Build the owner-presence change node (Feature A, A4) — a compact
 * plugin/notice node carrying `Owner presence: present|absent` + the matching
 * presence guidance line. It is the ONLY presence channel now (A4 dedup,
 * 2026-08-23): produced by the fire-and-forget `presence/set` host notify
 * (`notifyHostPresence` → `target.followup`) when the flag CHANGES, so the host
 * observes the toggle on its next turn. The `agent/pre-step` TRANSITION node
 * was REMOVED (it duplicated the notify); the CURRENT presence state is instead
 * baked into every host wake pack via `buildWakePack`'s `ownerPresence` (read
 * at assembly time) — covering restarts/future sessions without re-notifying.
 * The single content text block keeps the first line byte-identical
 * (`Owner presence: present|absent`), then appends a literal newline and the
 * matching presence guidance line — so the dedup summary
 * (`Deepartments owner presence: present|absent.`) is untouched.
 */
export function buildPresenceMessage(present: boolean) {
  const text = `Owner presence: ${present ? 'present' : 'absent'}\n${presenceGuidance(present)}`
  return createUserMessage({
    content: [
      { type: 'text', text }
    ],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary(`Deepartments owner presence: ${present ? 'present' : 'absent'}.`)
    }
  })
}

/**
 * Task T4 — the compact ROLE-focused orientation injected into a TRANSIENT
 * dispatched subagent (origin === 'subagent') at its first pre-step, in place
 * of the full ~4.6-4.9k-token host wake pack. One org line + the per-role
 * contract block (from the bundle `src/role-orient.ts` — the single source,
 * injected as `buildSubagentOrientation` via `WakePackDeps`) + a reporting
 * pointer. Same plugin/notice surface as the host pack so it lands as a
 * collapsed row.
 *
 * ROLE_CONTRACTS CONSOLIDATION (FASE 2.5 BATCH B): `buildSubagentOrientation`
 * is NOT imported from a role-orient copy here — it is the injected bundle
 * function (`deps.buildSubagentOrientation`), so this package owns no copy of
 * the role contracts.
 */
export function buildSubagentOrientationMessage(
  role: SubagentRole,
  buildSubagentOrientation: (role: SubagentRole, orgLabel: string) => string
) {
  // The injected builder takes an ORG label (E2: the B3 `roomId` param debt is
  // cleaned — rooms were removed, so the identity names the org, never a room);
  // the pre-step passes the org label so the subagent identity never names a
  // board room.
  return createUserMessage({
    content: [{ type: 'text', text: buildSubagentOrientation(role, 'deepartments') }],
    source: {
      kind: 'plugin',
      plugin: 'deepartments',
      form: 'notice',
      summary: boundContextSummary('Deepartments · subagent — role-focused orientation (role contract injected; no host wake pack).')
    }
  })
}

/** One configured department as the wake-pack DIRECTORIO (E2) consumes it: the
 * structural slice of `org.departments[]` the directory needs (display name +
 * head postId + the E2 purpose/services descriptors). Sourced EXCLUSIVELY from
 * config (the assembly passes it; the org chart is NEVER hardcoded here) —
 * adding/removing a department = editing the config. */
export interface DirectoryDepartment {
  /** The department display name (config.org.departments[].name). */
  name?: string
  /** The department's coordinator (head) post id — the send_message target. */
  coordinator?: { postId?: string }
  /** E2 — one-line: what the department does. */
  purpose?: string
  /** E2 — one-line: how to request the department's services (the REQUEST
   * format + the send_message target). */
  services?: string
}

/** The org-wide ACL note appended to the DIRECTORIO section (E2): head ↔ head
 * requests cross departments; a worker never crosses — it asks its own head. */
export const DIRECTORY_ACL_NOTE =
  'Cualquier head puede pedir los servicios de otro departamento por send_message a su head (ACL head↔head); un worker nunca cruza departamentos — pide a su propio head, que retransmite.'

/**
 * Build the compact `## Departments directory` section BODY (E2): ONE line per
 * configured department that carries directory info (`- <name> (<head>): <purpose>
 * Pídelo con un <services>.`), then the org-wide ACL note. PURE: the input is
 * the slice of `config.org.departments[]` the assembly passes — nothing is read
 * from config here. A department WITHOUT purpose AND services contributes NO
 * line (a legacy config without the E2 fields → no directory info → no line, and
 * an empty result returns '' so the caller omits the section, R6). An EMPTY
 * departments array → '' (no directory present → section absent).
 */
export function buildDepartmentsDirectory(departments: readonly DirectoryDepartment[]): string {
  const lines: string[] = []
  for (const department of departments) {
    const name = (department.name ?? '').trim()
    const head = department.coordinator?.postId?.trim() ?? ''
    const purpose = (department.purpose ?? '').trim()
    const services = (department.services ?? '').trim()
    if (name === '' || head === '') continue
    if (purpose === '' && services === '') continue // R6: no directory info → no line
    // Join purpose + how-to-request into ONE compact line, ending with a
    // single period: `- Name (head): purpose. Pídelo con un services.`
    const bits = [`- ${name} (${head})`]
    if (purpose !== '') bits.push(`: ${purpose}`)
    if (services !== '') bits.push(`${purpose !== '' ? '.' : ''} Pídelo con un ${services}`)
    lines.push(`${bits.join('')}.`)
  }
  if (lines.length === 0) return '' // no directory info anywhere → section absent
  lines.push(`- ${DIRECTORY_ACL_NOTE}`)
  return lines.join('\n')
}

/** Canonical host wake routine (verbatim — wake-pack section 9 guidance; the
 * skill's "Wake routine (injected wake)" section + checklist mirror it). The
 * journal footer is one-line pointer to the skill, so this text is NOT
 * duplicated in dept_sleep seeds (Batch C P1 dedupe, see ~2051). */
export const HOST_WAKE_ROUTINE_TEXT =
  'Start-of-session: your Deepartments context injection already carries identity, the pre-resolved journal path + journal body, the message delta (latest received), the condensed roster, git bearings, system state, and the full deepartments-workflow skill. Read it — do not re-fetch what the pack provides. Only call tools for LIVE needs the pack cannot cache: true session liveness (dept_who), full text of a message you must answer (agent_messages before- cursor), writes (send_message), or dept_sleep. REPLY FIRST: your first output of the wake turn is the owner-facing message — greeting + a <=5-line top-item plan + the explicit ask "what do you want this session?" — before ANY tool call (the only exception: the fail-loud health check when the pack itself is stale/ambiguous, which still surfaces the situation to the owner before working). The plan is PROPOSED, not authorized: do NOT dispatch subagents, explore the codebase, or start the item until the human answers; to ground the plan, at most 1–2 reads of a journal-referenced report and zero src/checkout exploration or bash before go-ahead. Then pick the highest-priority unfinished open item, present a concise plan, and WAIT for the owner\'s answer before working. Full sequence: skill deepartments-workflow ("Wake routine").'

/** The closing guidance line that follows the canonical routine in the pack. */
export const HOST_WAKE_NEXT_STEP =
  'next step: pick the highest-priority unfinished open item from the journal and present a concise plan — but reply FIRST: your first output of the wake turn is the owner-facing message (greeting + a <=5-line plan + "what do you want this session?") before ANY tool call, and the plan stays PROPOSED until the human answers: do NOT dispatch subagents, explore the codebase, or start the item, and keep grounding to at most 1–2 reads of a journal-referenced report with zero src/checkout bash before go-ahead.'

/**
 * The pre-rendered parts `buildWakePack` composes. Every field except
 * memberId/role/messageDelta/roster is OPTIONAL: the wake injection supplies
 * all of them (sections 1-10), while the on-demand `dept_wake_snapshot` supplies
 * only identity+messageDelta+roster (sections 1, 4, 5). A section is rendered
 * exactly when its content is present — so the SAME pure builder produces both
 * the full wake pack and the lean live snapshot.
 */
export interface WakePackParts {
  memberId: string
  role: string
  /** wake_counter + top-1 open-item KPI line (wake injection only; section 1).
   * `assembleWakePack` computes it live from the journal, degrading gracefully
   * when the journal is absent — so a never-slept session still gets a KPI line. */
  kpi?: string
  /** Pre-resolved durable journal path (wake injection only; section 3). */
  journalPath?: string
  /** Message-delta TOC body (latest received, spec 003 §7.2). '' → empty
   * section (no messages yet). */
  messageDelta: string
  /** Condensed roster (registry flags only — NEVER live session liveness). */
  roster: string
  /** E2 — the `## Departments directory` section BODY (one line per configured
   * department + the ACL note), assembled by the caller from
   * `config.org.departments[]` via `buildDepartmentsDirectory`. Undefined/'' →
   * the section is OMITTED (a legacy config without purpose/services, or no
   * departments at all, gets no directory — R6; the lean on-demand snapshot
   * does NOT carry it either). */
  departmentsDirectory?: string
  /** Git bearings (section 6; wake injection only). */
  git?: string
  /** System state (section 7; wake injection only). */
  systemState?: string
  /** ROADMAP "Current status" tail (section 8; wake injection only). */
  roadmapTail?: string
  /** Full deepartments-workflow skill body (section 9; wake injection only). */
  skillBody?: string
  /** Include the closing guidance (section 10)? Defaults true (wake injection). */
  includeGuidance?: boolean
  /** Owner-presence snapshot (Feature A/A4 dedup, 2026-08-23; section 2): a
   * line `## Owner presence: present|absent` rendering the CURRENT state read
   * at wake-pack assembly time, followed by the matching presence guidance line
   * (`presenceGuidance`) when the state is present/absent. Present in EVERY
   * host wake pack (always inject the current state). Undefined/empty → the
   * line is OMITTED (a presence read failure degrades to "no line", never a
   * throw) — transitions are carried by the bus notify (notifyHostPresence),
   * never re-sent as a second node. Only the host wake injection supplies it;
   * the lean on-demand snapshot (dept_wake_snapshot) does NOT. */
  ownerPresence?: string
  /** W8-d PART A — the `## System heartbeat:` section BODY (already-built,
   * brace-safe), injected into every HOST wake pack by `assembleWakePack` when
   * `health.heartbeatEnabled` (default on). Computed by the SAME pure snapshot
   * helpers the W8-c watchdog reuses (buildPostSnapshot / scanHostWaits):
   * host last-activity, per-active agent last-activity (NO SESSION / SLEEPING),
   * pending message counts + oldest ages, and a WAIT line when the host holds a
   * quiet expectation. Undefined/empty → the section is OMITTED (never a
   * throw) — and `health.heartbeatEnabled === false` explicitly omits it. The
   * section passes through `sanitizePromptLiterals` at the wake-pack seam. */
  heartbeat?: string
}

/** Compose the Deepartments context pack as a string, sections 1-10 in order.
 * PURE: no I/O, no registry/live reads — every section body is provided by the
 * caller. Enforces the deep rule by construction: there is simply no channel to
 * inject live `sessionLive` liveness here. */
export function buildWakePack(parts: WakePackParts): string {
  const sections: string[] = []

  // 1 — header + identity (+ the P1 presence sentinel as the very first body
  // element, and the P2 wake_counter/top-open-item KPI line when supplied).
  const identityLines = [
    '## Deepartments wake pack',
    'pack-v1: present',
    `- identity: ${parts.memberId} (role: ${parts.role})`
  ]
  if (parts.kpi !== undefined && parts.kpi.trim() !== '') {
    identityLines.push(`- kpi: ${parts.kpi}`)
  }
  sections.push(identityLines.join('\n'))

  // 2 — current owner-presence snapshot (Feature A/A4 dedup, 2026-08-23): the
  // line `## Owner presence: present|absent` rendering the state read at
  // assembly time, followed by the matching presence guidance line when the
  // state is present/absent. ALWAYS rendered for the host wake pack; for a
  // supplied state that is neither present nor absent, ONLY the header line is
  // rendered (unchanged behavior); OMITTED (never a throw) when no state is
  // supplied — the bus notify (notifyHostPresence) carries transitions instead,
  // so the host is never told twice.
  const presenceState = parts.ownerPresence?.trim().toLowerCase()
  if (presenceState === 'present' || presenceState === 'absent') {
    sections.push(`## Owner presence: ${presenceState}\n${presenceGuidance(presenceState === 'present')}`)
  } else if (parts.ownerPresence !== undefined && parts.ownerPresence.trim() !== '') {
    sections.push(`## Owner presence: ${parts.ownerPresence.trim()}`)
  }

  // 2b — W8-d PART A: the current `## System heartbeat:` snapshot (host + per
  // active agent last-activity, pending ages, WAIT line), built at assembly
  // time by the same pure snapshot helpers the W8-c watchdog reuses
  // (buildPostSnapshot / scanHostWaits — see `buildHeartbeatSection`). A
  // caller that supplies no body (or `health.heartbeatEnabled === false`) gets
  // no section — OMITTED, never a throw. Only the host wake injection supplies
  // it; the lean on-demand snapshot does NOT.
  if (parts.heartbeat !== undefined && parts.heartbeat.trim() !== '') {
    sections.push(`## System heartbeat:\n${parts.heartbeat}`)
  }

  // 3 — journal pointer (wake injection only)
  if (parts.journalPath !== undefined && parts.journalPath.trim() !== '') {
    sections.push([
      '## Journal (long-term memory)',
      `Pre-resolved journal path: \`${parts.journalPath}\``,
      'The journal body is the adjacent injected node.'
    ].join('\n'))
  }

  // 4 — message delta TOC (latest received; always rendered; body may be empty)
  sections.push(
    parts.messageDelta.trim() === ''
      ? '## Message delta (received)'
      : `## Message delta (received)\n${parts.messageDelta}`
  )

  // 5 — condensed roster (always rendered)
  sections.push(`## Condensed roster\n${parts.roster}`)

  // 5b — E2 DIRECTORIO de departamentos: the compact cross-department
  // directory, assembled from config.org.departments[] (buildDepartmentsDirectory
  // is pure — the assembly supplies the slice; the org chart is NEVER hardcoded
  // here). Present only when a non-empty body is supplied: a legacy config
  // without purpose/services (or no departments at all) → no directory info →
  // the section is OMITTED (R6); the lean on-demand snapshot also omits it.
  if (parts.departmentsDirectory !== undefined && parts.departmentsDirectory.trim() !== '') {
    sections.push(`## Departments directory\n${parts.departmentsDirectory}`)
  }

  // 6 — git bearings
  if (parts.git !== undefined && parts.git.trim() !== '') {
    sections.push(`## Git bearings\n${parts.git}`)
  }

  // 7 — system state
  if (parts.systemState !== undefined && parts.systemState.trim() !== '') {
    sections.push(`## System state\n${parts.systemState}`)
  }

  // 8 — ROADMAP "Current status" tail
  if (parts.roadmapTail !== undefined && parts.roadmapTail.trim() !== '') {
    sections.push(`## ROADMAP current status (tail)\n${parts.roadmapTail}`)
  }

  // 9 — full skill body
  if (parts.skillBody !== undefined && parts.skillBody.trim() !== '') {
    sections.push(`## deepartments-workflow skill (full body)\n${parts.skillBody}`)
  }

  // 10 — guidance (canonical routine + next step; wake injection only)
  if (parts.includeGuidance !== false) {
    sections.push([
      '## Guidance (wake routine)',
      HOST_WAKE_ROUTINE_TEXT,
      HOST_WAKE_NEXT_STEP
    ].join('\n'))
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// The wake-pack SERVICE (per-apply construction; deps injected).
// ---------------------------------------------------------------------------

/** The surface-op arguments (a full-window replace, or a bare append when the
 * surface is empty — a replace needs at least one existing node to shadow). */
export interface HostSleepSurfacePlan {
  surfaceOp: { op: 'replace'; start: number; end: number } | 'append'
  /** Present for the replace branch: every currently-shadowed surface node. */
  sourceEventSeqs?: number[]
}

/** Task T4 — session header AS OBSERVED AT RUNTIME: dsh-session FLATTENS the
 * creation-meta whitelist into TOP-LEVEL header keys (SessionService.prepare:
 * `header.origin = meta.origin`, `header.parentSession`, … —
 * dsh-session/lib/index.js:1657-1668); a nested `header.meta` key NEVER exists
 * at runtime (verified against persisted session records, which carry flat
 * `{"origin":"subagent","delegationDepth":1,parentSession,…}`). Transient
 * dispatched subagents carry flat `origin === 'subagent'` (dsh-subagent
 * childSessionMeta); registered hosts/heads/workers carry `origin: undefined`.
 * The nested `meta` member is kept ONLY as a defensive fallback for stale/mocked
 * headers — it is never the discriminator. */
export interface WakeHeaderOrigin {
  origin?: unknown
  meta?: { origin?: unknown }
}

/** The `agent`-shaped surface the pre-step injector reads. Declared structurally
 * (mirrors invoke.ts's `AgentLike`) so the module never hard-depends on dsh-agent. */
export interface WakePreStepAgentLike {
  id: string
  session?: {
    header?: unknown
    surface?: { nodes?: readonly number[] }
    // A fully-loose append signature so the REAL dsh-agent `Session.append`
    // (a generic `<T extends SessionEventType>(type, data, ...opts)`) is
    // assignable to this structural view (the injector keeps the exact
    // invocation below). Declared structurally — never a hard dsh-agent dep.
    append?: (...args: any[]) => unknown
  }
}

/** The `agent/pre-step` listener args (host + signal), as the injector reads them. */
export interface WakePreStepArgs {
  agent?: WakePreStepAgentLike
  signal?: AbortSignal
}

/** The `agent/pre-step` decision the injector returns (or passes through). */
export interface WakePreStepDecision {
  kind: string
  messages: unknown[]
}

/** Structural view of the message-store the wake delta reads (only `page`). */
export interface WakeMessageStoreLike {
  page(recipientId: string, opts: { limit: number; before?: string }): { messages: MessageRecord[] }
}

/** The deps a `WakePackService` needs from the apply fiber (or a test harness).
 * Injected so the service stays free of any module-global state and free of the
 * invoke.ts closure, while the CLOSURE-BOUND primitives (the catalog identity
 * resolvers, the deferred sleep surface replace, the health-heartbeat assembly,
 * the presence cache) are provided as injected callbacks. */
export interface WakePackDeps {
  /** The live catalog maps (the SAME live RegistryStore maps the apply reads). */
  byPost: ReadonlyMap<string, PostEntry>
  hosts: ReadonlyMap<string, HostEntry>
  getHost(hostId: string): HostEntry | undefined
  /** Resolve a child session to its registered postId (host-only gate). */
  postIdForChild(sessionId: string): string | undefined
  /** The deterministic `host-<sessionId>` member id. */
  hostIdForSession(sessionId: string): string
  /** Re-read the synchronous presence cache at each host turn. */
  refreshPresence(): void
  /** The session-scoped wake-pack injected gate (cleared at host dept_sleep). */
  wakePackInjected: Set<string>
  /** The deferred in-place surface reset intent (consumed at the first pre-step). */
  deferredSleepReplace: Map<string, string>
  /** Fire-and-forget hosts.json persistence (the deferred seed consume). */
  persistHosts(): void
  /** Resolve the transient-subagent role (single source = bundle role-orient). */
  roleForSession(sessionId: string): SubagentRole
  /** Build the compact subagent-orientation block (single source = bundle
   * `src/role-orient.ts` — INJECTED, never a role-orient copy in this package).
   * The second param is the ORG label (E2 cleanup of the B3 `roomId` debt). */
  buildSubagentOrientation(role: SubagentRole, orgLabel: string): string
  /** E2 — the configured departments (the slice of `config.org.departments[]`
   * the DIRECTORIO section needs: name + coordinator.postId + purpose/services).
   * Optional: absent/undefined → the directory section is omitted (R6; a
   * composition without the dep degrades to the pre-E2 pack). */
  departments?: readonly DirectoryDepartment[]
  /** The deferred sleep surface replace plan (Batch 7 helper — kept in invoke). */
  computeHostSleepSurfacePlan(nodes: readonly number[]): HostSleepSurfacePlan
  /** The deferred journal node builder (Batch 7 helper — kept in invoke). */
  buildSleepJournalMessage(journalText: string): unknown
  /** The W8-d heartbeat snapshot builder (health concern — kept in invoke). */
  assembleHeartbeat(hostId: string): string | undefined
  /** The presence-state file read (the presence cache is injected + refreshed). */
  readPresenceStateFile(stateDir: string): { present: boolean }
  /** The durable journal path for a member. */
  journalPathFor(memberId: string): string
  /** The live message store (promise; resolved lazily at assembly time). */
  messagesStoreReady: () => Promise<WakeMessageStoreLike>
  /** The live stateDir (system-state block). */
  stateDir: string
  /** The repo root (git / ROADMAP / skill reads). */
  repoRoot: string
  /** The cordis logger (degrade warnings). */
  logger: { warn(message: string): void }
}

/** The per-apply wake-pack service surface the invoke fiber calls. */
export interface WakePackService {
  /** Assemble the FULL wake context pack (sections 1-10) for the host wake
   * injection (identity + KPI + owner-presence state + pre-resolved journal path
   * + live message delta + roster + git + system state + ROADMAP tail + full
   * skill body + guidance). */
  assembleWakePack(memberId: string, journalPath: string): Promise<string>
  /** Assemble the LEAN on-demand wake snapshot (sections 1, 4, 5 only). */
  assembleWakeSnapshot(memberId: string): Promise<string>
  /** The condensed roster of the WHOLE catalog (registered posts + non-retired
   * hosts with their durable REGISTRY sleeping flags; NEVER live liveness). */
  buildCondensedRoster(): string
  /** The `agent/pre-step` listener: the Batch C fresh wake-pack injection. */
  preStepHandler: (args: WakePreStepArgs, next: () => Promise<unknown>) => Promise<unknown>
}

/** Construct the per-apply wake-pack service. Pure construction: no module-global
 * mutable state; the returned service closes only over the injected deps. */
export function createWakePackService(deps: WakePackDeps): WakePackService {
  /** Full body of the `deepartments-workflow` skill, resolved via the PRESET
   * path (a symlink into the repo) with the repo-tracked copy as fallback.
   * Missing/unreadable → graceful `(skill unavailable)`. */
  const readWakeSkillBody = async (): Promise<string> => {
    const candidates = [
      '/opt/dsh/.dsh-dev/.agent-presets/deepartments/skills/deepartments-workflow/SKILL.md',
      path.join(deps.repoRoot, '.dsh', 'skills', 'deepartments-workflow', 'SKILL.md')
    ]
    for (const candidate of candidates) {
      try {
        const body = await readFile(candidate, 'utf8')
        if (body.trim() !== '') return body
      } catch {
        /* try next */
      }
    }
    return '(skill unavailable)'
  }

  /** Condensed static system-state block (homes, ports, profiles, plugins,
   * live stateDir, repo root). Fully static at seed time. */
  const buildWakeSystemState = (): string => [
    '- DSH dev home: /opt/dsh/.dsh-dev (GUI profile "deepartments-dev", port 3090 / Tailscale 8445; headless twin "deepartments-dev-headless" for CLI smoke)',
    '- DSH stable home: /opt/dsh/.dsh (port 3080 / Tailscale 8444)',
    '- Plugins: dshmarket, dsh-smooth-stream, dsh-smart-restart',
    `- Live stateDir: ${deps.stateDir}`,
    `- Repo root: ${deps.repoRoot}`
  ].join('\n')

  /** Condensed roster of the WHOLE catalog (B3: no rooms): registered posts +
   * non-retired hosts with their durable REGISTRY sleeping flags. NEVER embeds
   * live `sessionLive` liveness (deep rule — a stale liveness claim is worse
   * than one on-demand `dept_who`); a pointer line keeps the on-demand escape
   * hatch explicit. The ACTIVE-ONLY filter is the SINGLE-SOURCE
   * `listActiveMembers` (registry.ts) — NOT duplicated here. */
  const buildCondensedRoster = (): string => {
    const lines: string[] = []
    for (const member of listActiveMembers(deps.byPost.values(), deps.hosts.values())) {
      if (member.kind === 'post') {
        lines.push(`- ${member.entry.postId}${member.entry.sleepEpoch !== void 0 ? ' (sleeping)' : ''} (${member.entry.agentPreset})`)
      } else {
        lines.push(`- ${member.entry.hostId}${member.entry.sleepEpoch !== void 0 ? ' (sleeping)' : ''}`)
      }
    }
    if (lines.length === 0) lines.push('(no registered posts/hosts)')
    lines.push('Liveness (sessionLive): not baked in — call dept_who on demand.')
    return lines.join('\n')
  }

  /** Message-delta TOC for the wake pack (spec 003 §7.2): the caller's
   * LATEST-RECEIVED messages from the messages.jsonl store (capped N,
   * newest-first; no unread/read state — D5). Missing/unreadable store →
   * an empty-cursor line (never throw). */
  const readWakeMessageDelta = async (memberId: string): Promise<string> => {
    const lines: string[] = []
    try {
      const store = await deps.messagesStoreReady()
      const page = store.page(memberId, { limit: WAKE_MESSAGE_DELTA_LIMIT })
      for (const message of page.messages) {
        lines.push(formatMessageDeltaLine(message))
      }
    } catch (error: unknown) {
      deps.logger.warn(`[deepartments] wake message delta unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    if (lines.length === 0) lines.push('(no messages received yet)')
    return lines.join('\n')
  }

  /** KPI line for pack section 1 (P2): `wake_counter N; top open item: …`
   * computed live from the journal file (the same durable file dept_sleep
   * seeds), so the first turn after wake is confirm-and-go instead of
   * cross-reading the journal. Missing/unreadable journal → a clear degraded
   * line; NEVER throws. */
  const readWakeJournalKpi = async (journalPath: string): Promise<string> => {
    try {
      const text = await readFile(journalPath, 'utf8')
      const counterMatch = text.match(/^wake_counter:\s*(\d+)/m)
      const counter = counterMatch !== null ? counterMatch[1] : '?'
      let top = '(none)'
      const openMatch = text.match(/^open_items:\s*(\[.*\])/m)
      if (openMatch !== null) {
        try {
          const parsed = JSON.parse(openMatch[1]) as unknown
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') top = parsed[0]
        } catch { /* fallthrough to (none) */ }
      }
      return `wake_counter ${counter}; top open item: ${top}`
    } catch {
      return 'wake_counter (unavailable); top open item: (unavailable)'
    }
  }

  /** git status (short) + last 8 `git log --oneline` lines for the repo,
   * computed at assembly time in the repo dir. Unreachable git/repo → static
   * `(git unavailable)` (degrade gracefully, never throw). */
  const readWakeGitBearings = async (): Promise<string> => {
    try {
      const status = await execFileP('git', ['status', '--short'], { cwd: deps.repoRoot })
      const log = await execFileP('git', ['log', '--oneline', '-8'], { cwd: deps.repoRoot })
      const statusLines = status.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const logLines = log.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const body: string[] = []
      body.push(`status: ${statusLines.length === 0 ? 'clean working tree' : statusLines.join('; ')}`)
      body.push(`last ${logLines.length} commits:`)
      body.push(...logLines.map((l) => `  ${l}`))
      return body.join('\n')
    } catch {
      return '(git unavailable)'
    }
  }

  /** The 2-3 NEWEST bullets from the ROADMAP "Current status" section (the
   * newest entries sit at its tail). Missing/unreadable ROADMAP → graceful
   * marker. */
  const readWakeRoadmapTail = async (count = 3): Promise<string> => {
    try {
      const text = await readFile(path.join(deps.repoRoot, 'docs', 'ROADMAP.md'), 'utf8')
      const lines = text.split('\n')
      const start = lines.findIndex((l) => l.startsWith('## Current status'))
      if (start === -1) return '(ROADMAP "Current status" section not found)'
      const entries: string[][] = []
      let current: string[] | undefined
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i]
        if (line.startsWith('## ')) break
        if (/^\s*- /.test(line)) {
          current = [line]
          entries.push(current)
        } else if (current !== undefined && line.trim() !== '') {
          current.push(line)
        }
      }
      const newest = entries.slice(-count)
      if (newest.length === 0) return '(ROADMAP "Current status" has no bullets)'
      const folded = newest
        .map((entry) => `- ${entry.join(' ').replace(/\s+/g, ' ').trim().replace(/^-\s*/, '')}`)
        .join('\n')
      return folded
    } catch {
      return '(ROADMAP unavailable)'
    }
  }

  /** Assemble the FULL wake context pack (sections 1-10) for the host wake
   * injection: identity + KPI + current owner-presence state + pre-resolved
   * journal path + live message delta + roster + git + system state + ROADMAP
   * tail + full skill body + guidance. */
  const assembleWakePack = async (memberId: string, journalPath: string): Promise<string> => {
    const [messageDelta, git, roadmapTail, skillBody, kpi] = await Promise.all([
      readWakeMessageDelta(memberId),
      readWakeGitBearings(),
      readWakeRoadmapTail(),
      readWakeSkillBody(),
      readWakeJournalKpi(journalPath)
    ])
    // Feature A (A4 dedup, 2026-08-23) — read the CURRENT owner-presence state
    // at assembly time and bake it into the wake pack. `readPresenceStateFile`
    // never throws (an absent/unreadable file defaults present:true); the
    // defensive try/catch + the omitted-line degrade in buildWakePack guarantee
    // this path NEVER throws and NEVER renders a bogus presence line when the
    // state cannot be read — transitions are delivered by the bus notify.
    let ownerPresence: string | undefined
    try {
      const state = deps.readPresenceStateFile(deps.stateDir)
      ownerPresence = state.present === true ? 'present' : 'absent'
    } catch {
      ownerPresence = undefined
    }
    return buildWakePack({
      memberId,
      role: 'host',
      kpi,
      journalPath,
      messageDelta,
      roster: buildCondensedRoster(),
      // E2 — the DIRECTORIO de departamentos: assembled from the deps-provided
      // config.org.departments[] slice (the pack NEVER hardcodes the org chart;
      // add/remove a department = edit the config). Empty result → the section
      // is omitted by the pure builder (legacy config / no departments → R6).
      departmentsDirectory: buildDepartmentsDirectory(deps.departments ?? []),
      git,
      systemState: buildWakeSystemState(),
      roadmapTail,
      skillBody,
      ownerPresence,
      heartbeat: deps.assembleHeartbeat(memberId),
      includeGuidance: true
    })
  }

  /** Assemble the LEAN on-demand wake snapshot (sections 1, 4, 5 only — identity,
   * message delta, condensed roster) via the SAME pure `buildWakePack`
   * builder. Used by `dept_wake_snapshot` for live freshness mid-session. It
   * intentionally does NOT carry the owner-presence line (that is baked into
   * the host wake pack injection only; the snapshot is for on-demand reads). */
  const assembleWakeSnapshot = async (memberId: string): Promise<string> => {
    const messageDelta = await readWakeMessageDelta(memberId)
    return buildWakePack({
      memberId,
      role: 'host',
      messageDelta,
      roster: buildCondensedRoster(),
      includeGuidance: false
    })
  }

  // ---------------------------------------------------------------------------
  // Batch C — FRESH wake-pack injection at message-arrival time (owner
  // directive: the pack must arrive AFTER the user's message, together with the
  // standard DSH context injections, so its message delta / git bearings / roster
  // / cursor are fresh at message arrival, NOT frozen at the previous
  // dept_sleep). Driven by the SAME `agent/pre-step` Cordis waterfall the
  // runtime-context + skill-catalog use (no dsh-core change — the canonical
  // pattern is dsh-tool-skill/lib/index.js:181). We REUSE assembleWakePack /
  // buildWakePackMessage — no new pack builder.
  //
  // GATE — inject ONCE per awake session, never per turn: `agent/pre-step` runs
  // before EVERY model step (not just the first message of a session), so a
  // naive listener would re-inject the ~5kB pack on every tool-call step. The
  // recommended `decision.messages` presence check does NOT work here: `claim()`
  // (dsh-agent/lib/index.js:56) returns ONLY the per-step pending input, so
  // `decision.messages` carries the previously-injected pack node NO ACROSS
  // steps (verified against the agent-loop preStep, lib/index.js:496-508). We
  // therefore gate on a SESSION-SCOPED presence flag (`wakePackInjected`, keyed
  // by the agent session id) that is cleared only at the host dept_sleep
  // boundary, so a post-sleep wake (or a fresh never-slept session) injects
  // exactly once. Never injects into a registered POST (head/worker) — those
  // keep their lean message-delta wake, not the host pack.
  // ---------------------------------------------------------------------------
  const preStepHandler = async (args: WakePreStepArgs, next: () => Promise<unknown>): Promise<unknown> => {
    const decision = await next()
    const d = decision as WakePreStepDecision
    if (d.kind === 'reject') return decision
    const sessionId = args.agent?.id
    if (typeof sessionId !== 'string') return decision
    // Host-only: a registered post (head/worker) already has its own lean wake
    // surface; the host wake pack is for HOST Asistente sessions only.
    if (deps.postIdForChild(sessionId) !== void 0) return decision
    // Feature A (A4 dedup, 2026-08-23) — the owner-presence TRANSITION node was
    // REMOVED from the pre-step: the ONLY transition channel is the bus notify
    // (`notifyHostPresence`, fired by `presence/set` on a real CHANGE), so the
    // host is never told twice on a toggle. The CURRENT state is instead baked
    // into EVERY host wake pack (buildWakePack `ownerPresence`, read at
    // assembly time) — this covers restarts/future sessions without duplicating
    // notifications. The host entry is resolved here for the retired gate below.
    const hostId = deps.hostIdForSession(sessionId)
    const hostEntry = deps.getHost(hostId)
    // Keep the synchronous presence cache current at each host turn (it feeds
    // the A3 `ask_user_question` guard); presence.json is tiny.
    deps.refreshPresence()
    // Wake-pack gate — an already-injected session returns here UNCHANGED (a
    // repeated step re-injects neither the pack nor any presence node).
    if (deps.wakePackInjected.has(sessionId)) {
      return decision
    }
    // ---- Task T4: TRANSIENT dispatched subagent → slim ROLE-focused block, NOT
    // the full ~4.6-4.9k host pack. `origin === 'subagent'` is the robust
    // discriminator DSH sets ONLY on startContinuable children (dsh-subagent
    // childSessionMeta); a root host/head/worker carries origin undefined. A
    // one-shot atomic-task worker needs its role contract + a one-line org
    // identity, never journal/git/system/ROADMAP/roster/full-skill. The role
    // comes from the in-process dispatch-time registry (the bundle's
    // src/role-orient.ts — the single source of truth), defaulting to `generic`
    // when unknown or after a cold resume.
    // Read the FLAT top-level origin — the real runtime shape (dsh-session
    // flattens the creation meta into header.origin; header.meta never exists
    // at runtime — dsh-session/lib/index.js:1657-1668). The nested
    // meta.origin fallback covers only stale/mocked headers and can never
    // shadow the flat value (`??` reads it ONLY when flat origin is absent).
    const sessionHeader = (args.agent?.session?.header ?? {}) as WakeHeaderOrigin
    const sessionOrigin = sessionHeader?.origin ?? sessionHeader?.meta?.origin
    if (sessionOrigin === 'subagent') {
      args.signal?.throwIfAborted?.()
      const role = deps.roleForSession(sessionId)
      deps.wakePackInjected.add(sessionId)
      return {
        kind: 'enter',
        messages: [...d.messages, buildSubagentOrientationMessage(role, deps.buildSubagentOrientation)]
      }
    }
    args.signal?.throwIfAborted?.()
    // Fix 2026-08-22 — context-injection gate: the host wake pack goes ONLY to
    // the session REGISTERED as the board host in hosts.json (the boot-loaded
    // `hosts` Map). A plain root session (never registered) now gets NO
    // Deepartments context. The gated-off path must NOT add to
    // `wakePackInjected`: a session that registers LATER mid-session (first
    // board-tool call → ensureHost) still receives the pack at its next
    // pre-step ("plain until it becomes the registered host"). Registered
    // posts are already gated above (2624) and transient subagents in the T4
    // branch above (2641) — both keep their behavior untouched. The `hostEntry`
    // was resolved in the host-entry resolution above (no re-read); U2 (spec 002 §4):
    // a RETIRED host entry never gets the wake pack — retire means "no pack +
    // no registration"; a message typed into the old tab after a rotation
    // behaves as a PLAIN session (deliberate). The off-path stays free of
    // `wakePackInjected` (a legacy mid-session registration still works — see
    // the comment above).
    if (hostEntry === void 0 || hostEntry.retired === true) return decision
    // Fix A — deferred in-place surface reset (see the Batch 7 helper comment +
    // dept_sleep Step 3): the FIRST pre-step after a host dept_sleep performs
    // the full-window replace the close branch no longer runs. By this point
    // the harness has appended the dept_sleep tool result AFTER the close
    // journal append, so the live surface ends with a pending role:'tool' node
    // whose assistant tool-call parent sits BEFORE the journal node. Replacing
    // the ENTIRE window — start: first node → end: LAST node (the tool result
    // included; computeHostSleepSurfacePlan derives the plan from the CURRENT
    // surface so provenance covers every node exactly) — folds the surface back
    // to the journal BEFORE any request is built (the agent-loop requests
    // session.deriveMessages() AFTER the pre-step waterfall), so the strict
    // opencode-go API never sees the orphaned tool message. Degrades
    // silently when the session is a stub (no append) — same guard as close.
    const deferredJournal = deps.deferredSleepReplace.get(sessionId)
    if (deferredJournal !== void 0) {
      deps.deferredSleepReplace.delete(sessionId)
      // Fix wake-12: consuming the in-memory intent must ALSO clear the
      // DURABLE seed (HostEntry.deferredJournalSeed) — the same consume-once
      // contract. If the durable seed survived, a mid-wake restart would
      // restore it and the first pre-step would re-fold the WHOLE wake surface
      // (journal + every wake turn) back to the journal — silently losing the
      // wake conversation. Clearing here makes the restart after a fold a no-op.
      // Fire-and-forget persist like every other hosts.json write.
      if (hostEntry !== void 0 && hostEntry.deferredJournalSeed !== void 0) {
        hostEntry.deferredJournalSeed = void 0
        deps.persistHosts()
      }
      const session = args.agent?.session
      if (session !== void 0 && typeof session.append === 'function') {
        const nodes = (session.surface?.nodes as readonly number[] | void) ?? []
        const plan = deps.computeHostSleepSurfacePlan(nodes)
        session.append('user/message', deps.buildSleepJournalMessage(deferredJournal), {
          surfaceOp: plan.surfaceOp,
          ...(plan.sourceEventSeqs !== void 0 ? { sourceEventSeqs: plan.sourceEventSeqs } : {})
        })
      }
    }
    // Deterministic journal path even for a never-slept host (no durable
    // journal yet): assembleWakePack's sections degrade to '(… unavailable)'
    // and readWakeJournalKpi returns a degraded KPI line — the injector never
    // throws for a missing journal/file, so a brand-new host still gets a pack.
    const pack = await assembleWakePack(hostId, deps.journalPathFor(hostId))
    deps.wakePackInjected.add(sessionId)
    // The wake pack alone orients — it carries the CURRENT owner-presence state
    // (section 2); a later toggle is delivered by the bus notify, never by a
    // second pre-step node (A4 dedup, 2026-08-23).
    return {
      kind: 'enter',
      messages: [...d.messages, buildWakePackMessage(pack)]
    }
  }

  return { assembleWakePack, assembleWakeSnapshot, buildCondensedRoster, preStepHandler }
}
