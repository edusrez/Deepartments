// dsh-deepartments — FOLLOWUP-CONTRACT test (FB-266, 2026-09-08).
//
// Locks the `followup` TYPE CONTRACT across the five AgentLike mirror sites of
// the repo:
//   - src/invoke.ts          (the bundle-local AgentLike — the root build's
//                             source of truth for the delivery coupling);
//   - packages/dshd-orchestration/src/delivery.ts (the ORIGIN of the
//                             UserMessage form — fb-249 b814101 changed
//                             THIS site only);
//   - packages/dshd-orchestration/src/tools.ts  (mirror);
//   - packages/dshd-orchestration/src/boot.ts   (mirror);
//   - packages/dshd-orchestration/src/spawn.ts  (mirror).
//
// LOCATED BY SYMBOL, NEVER BY LINE NUMBER (VALLE 2026-09-15, builder-345): the
// list above is a FILE list; inside each file the DECLARATION is located by its
// own member text (`findFollowupDeclLines`). Cited by form: the retired oracle
// pinned five anchors — an array of `declAt: <n>` entries which was read as
// `lines[site.declAt - 1]` and asserted trim-equal to the declaration string.
// Those numbers rotted under ordinary line drift (the declarations were all
// still present) and turned this file RED at HEAD for a NON-defect. That oracle
// is gone: a line-number anchor is not a symbol.
//
// The BUG (fb-266): b814101 changed delivery.ts's `followup(message:
// UserMessage)` but did NOT mirror it in invoke/tools/boot/spawn — the 4
// mirrors kept the legacy inline shape `{ content: readonly { type: string;
// text: string }[]; source: Record<string, unknown> }` → 4x TS2719 in the root
// build the first time the package libs are regenerated (the stale-prebuilt
// masking class fb-248). This test FREEZES the contract so a future
// un-mirrored drift fails the suite loudly:
//   - DECLARATION: every `followup(message:` site must declare the EXACT
//     `followup(message: UserMessage): void` form;
//   - IMPORT: every mirror file must import the `UserMessage` TYPE from
//     `@deepseek-ai/dsh-llm` (the same module delivery.ts:334 imports);
//   - NO LEGACY: the old inline `{ content: readonly { type: string; text:
//     string }[]; source: ...` shape must appear NOWHERE in src/ +
//     packages/*/src.
// Plus a RUNTIME probe: `createUserMessage` (the exact builder delivery.ts uses
// at the bus seam, delivery.ts:1225) produces a message carrying the fields the
// legacy shape MISSED (role/id — the TS2719 'missing properties' pair), so the
// UserMessage form is the real runtime wire format, not an arbitrary rename.
//
// Style: read-only + dependency-free source scan (the org-config-parity
// pattern) + the dsh-llm runtime probe. Hermetic: no Loader, no stateDir, plain
// `node --test`.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The five AgentLike mirror sites that must declare the SAME followup type.
 * delivery.ts is the ORIGIN; the other four are the mirrors that drifted.
 *
 * `declCount` (2026-09-15, builder-345): the number of lines that must carry
 * the EXACT declaration — i.e. the number of lines whose `trim()` EQUALS
 * USERMESSAGE_DECL. For all five sites that number is 1: one declaration per
 * surface, and `assert.equal(found.length, declCount)` makes a SECOND
 * declaration in the same surface a failure too (a duplicate member is the
 * same TS-class defect, not a spare).
 *
 * NOTE per file (the "which count" declaration): boot.ts carries TWO FURTHER
 * `followup(message: unknown): void` members (the loose inline `agents.get(id)`
 * projection type) — those are NOT AgentLike declarations and are NOT counted;
 * only the `UserMessage` form is. Any probe of boot.ts showing 0 exact-form
 * lines must show those unknown-form lines in the same breath (the oracle's
 * failure message does exactly that). */
const MIRROR_SITES = Object.freeze([
  { file: 'src/invoke.ts', declCount: 1, role: 'origin-of-coupling' },
  { file: 'packages/dshd-orchestration/src/delivery.ts', declCount: 1, role: 'origin' },
  { file: 'packages/dshd-orchestration/src/tools.ts', declCount: 1, role: 'mirror' },
  { file: 'packages/dshd-orchestration/src/boot.ts', declCount: 1, role: 'mirror' },
  { file: 'packages/dshd-orchestration/src/spawn.ts', declCount: 1, role: 'mirror' }
])

const USERMESSAGE_DECL = 'followup(message: UserMessage): void'
const LEGACY_DECL_PART = 'followup(message: { content: readonly { type: string; text: string }[]; source:'
const DSH_LLM_MODULE = '@deepseek-ai/dsh-llm'

/** SYMBOL LOCATOR (never a line number): every line of `text` whose `trim()`
 * EQUALS the exact declaration, as `{ line, text }` (1-based `line`, derived —
 * reported for citation, never used as an anchor). Shifting the file by N lines
 * moves both the declaration and this result together: the assertion holds. */
function findFollowupDeclLines(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === USERMESSAGE_DECL) out.push({ line: i + 1, text: trimmed })
  }
  return out
}

/** Every line mentioning the `followup` MEMBER at all — the positive/alternate
 * control the failure message carries in the SAME call as the absence verdict
 * (an absence probe without it cannot distinguish "declaration removed" from
 * "file never read" / "the member is spelled differently here"). */
function followupMentions(text) {
  const lines = text.split('\n')
  return lines
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter((entry) => entry.text.includes('followup'))
}

/** True when `text` has an import statement from `@deepseek-ai/dsh-llm` whose
 * specifier list carries the `type UserMessage` binding — covers BOTH the
 * pure-type form (`import type { UserMessage } from …`) and the mixed form
 * (`import { createUserMessage, …, type UserMessage } from …`). */
function importsUserMessageType(text) {
  return /import\s+type\s*\{[^}]*\bUserMessage\b[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-llm['"]/.test(text) ||
    /import\s*\{[^}]*\btype\s+UserMessage\b[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-llm['"]/.test(text)
}

test('followup-contract: the five AgentLike mirror sites declare the EXACT `followup(message: UserMessage): void` form', async () => {
  for (const site of MIRROR_SITES) {
    const abs = path.join(REPO_ROOT, site.file)
    const text = await readFile(abs, 'utf8')
    const found = findFollowupDeclLines(text)
    assert.equal(
      found.length,
      site.declCount,
      `${site.file} (${site.role}) must declare \`${USERMESSAGE_DECL}\` on exactly ${site.declCount} line(s) — found ${found.length} ` +
        `(${found.map((d) => `:${d.line}`).join(', ') || 'none'}). Read ${text.split('\n').length} line(s) of the file (positive control that ` +
        `the file WAS inspected); every \`followup\` mention in it (the alternate-spelling / positive control, same call): ` +
        `${JSON.stringify(followupMentions(text))}`
    )
  }
})

test('followup-contract: every mirror file imports the UserMessage TYPE from @deepseek-ai/dsh-llm (same module as the ORIGIN site delivery.ts)', async () => {
  for (const site of MIRROR_SITES) {
    const abs = path.join(REPO_ROOT, site.file)
    const text = await readFile(abs, 'utf8')
    // The import must carry the `type UserMessage` binding from the EXACT
    // @deepseek-ai/dsh-llm module (a structural re-declare elsewhere would
    // re-open the "two different types with this name" TS2719 class).
    assert.ok(
      importsUserMessageType(text),
      `${site.file} (${site.role}) must import \`type UserMessage\` from '${DSH_LLM_MODULE}'`
    )
  }
})

test('followup-contract: the legacy inline `{ content: readonly ... }` followup shape exists NOWHERE in src/ + packages/*/src', async () => {
  const { readdir } = await import('node:fs/promises')
  /** Recursive .ts file list under `dir` (dependency-free scan — no grep). */
  async function tsFiles(dir) {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await tsFiles(full)))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }
  const hits = []
  for (const base of ['src', path.join('packages', 'dshd-orchestration', 'src'), path.join('packages', 'dshd-core', 'src')]) {
    for (const file of await tsFiles(path.join(REPO_ROOT, base))) {
      const text = await readFile(file, 'utf8')
      if (text.includes(LEGACY_DECL_PART)) hits.push(file)
    }
  }
  assert.deepEqual(hits, [], `legacy followup declaration shape must be gone — found in:\n${hits.join('\n')}`)
})

test('followup-contract (runtime probe): createUserMessage — the SAME builder delivery.ts uses — produces a message with the fields the legacy shape MISSED (role/id), i.e. the UserMessage form is the real wire format', async () => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const msg = createUserMessage({
    content: [{ type: 'text', text: 'contract probe' }],
    source: { kind: 'agent', form: 'send' }
  })
  assert.equal(msg.role, 'user', 'the followup message is a USER message (UserMessage.role === "user")')
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0, 'the followup message carries a stable id (UserMessage.id)')
  assert.ok(Array.isArray(msg.content) && msg.content.length === 1, 'the followup message carries the content blocks')
  assert.ok(msg.source !== undefined && typeof msg.source === 'object', 'the followup message carries the source projection')
  // The layer contract: a followup built BY createUserMessage is assignable to
  // the mirrored `followup(message: UserMessage)` — the type is structural, so
  // the runtime wire shape IS the declared compile-time shape.
  const probe = createHash('sha256').update(JSON.stringify({ role: msg.role, id: msg.id })).digest('hex').slice(0, 12)
  assert.ok(probe.length === 12, `probe digest sanity (${probe})`)
})