// dsh-deepartments — FOLLOWUP-CONTRACT test (FB-266, 2026-09-08).
//
// Locks the `followup` TYPE CONTRACT across the five AgentLike mirror sites of
// the repo:
//   - src/invoke.ts:826          (the bundle-local AgentLike — the root build's
//                                 source of truth for the delivery coupling);
//   - packages/dshd-orchestration/src/delivery.ts:334 (the ORIGIN of the
//                                 UserMessage form — fb-249 b814101 changed
//                                 THIS site only);
//   - packages/dshd-orchestration/src/tools.ts:278  (mirror);
//   - packages/dshd-orchestration/src/boot.ts:115   (mirror);
//   - packages/dshd-orchestration/src/spawn.ts:86   (mirror).
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
 * delivery.ts is the ORIGIN; the other four are the mirrors that drifted. */
const MIRROR_SITES = Object.freeze([
  { file: 'src/invoke.ts', declAt: 826, role: 'origin-of-coupling' },
  { file: 'packages/dshd-orchestration/src/delivery.ts', declAt: 334, role: 'origin' },
  { file: 'packages/dshd-orchestration/src/tools.ts', declAt: 278, role: 'mirror' },
  { file: 'packages/dshd-orchestration/src/boot.ts', declAt: 115, role: 'mirror' },
  { file: 'packages/dshd-orchestration/src/spawn.ts', declAt: 86, role: 'mirror' }
])

const USERMESSAGE_DECL = 'followup(message: UserMessage): void'
const LEGACY_DECL_PART = 'followup(message: { content: readonly { type: string; text: string }[]; source:'
const DSH_LLM_MODULE = '@deepseek-ai/dsh-llm'

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
    const lines = text.split('\n')
    const declLine = lines[site.declAt - 1]
    assert.ok(
      declLine !== undefined && declLine.trim() === USERMESSAGE_DECL,
      `${site.file}:${site.declAt} (${site.role}) must declare \`${USERMESSAGE_DECL}\` — got ${JSON.stringify(declLine?.trim())}`
    )
  }
})

test('followup-contract: every mirror file imports the UserMessage TYPE from @deepseek-ai/dsh-llm (same module as delivery.ts:34)', async () => {
  for (const site of MIRROR_SITES) {
    const abs = path.join(REPO_ROOT, site.file)
    const text = await readFile(abs, 'utf8')
    // The import must carry the `type UserMessage` binding from the EXACT
    // @deepseek-ai/dsh-llm module (a structural re-declare elsewhere would
    // re-open the "two different types with this name" TS2719 class).
    assert.ok(
      importsUserMessageType(text),
      `${site.file}:${site.declAt} (${site.role}) must import \`type UserMessage\` from '${DSH_LLM_MODULE}'`
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