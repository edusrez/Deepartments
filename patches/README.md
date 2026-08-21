# dsh-deepartments maintenance patches

The `dsh-deepartments` bundle sometimes needs fixes that cannot live inside the
repo's `src/` (they modify the *installed* DeepSeek Harness tree, which ships
from npm). Those fixes are kept here as **versioned patches** with a
fingerprint-gated re-apply script, so they survive `dsh` upgrades without
manual re-application.

## Fix B — dsh-llm-deepseek orphan role:'tool' sweep (the only patch today)

**Problem.** The host `dept_sleep` close can leave a *tool-result* block whose
`toolCallId` was never issued by any **preceding** assistant message's
`tool-call` block (broken interleave on the dept-close path). The upstream
strict DeepSeek validator (direct `deepseek-official` API) rejects such an
orphaned `{role:'tool'}` message with a 400 INVALID_REQUEST.

**Fix.** A never-throw orphan sweep in both serializers of the installed
`@deepseek-ai/dsh-llm-deepseek` lib — `serializeMessages` (plain path) and
`serializeMessagesWithImages` (image/vision path):

- track every tool-call id issued by an assistant message (`issuedToolCallIds`
  Set, one line in the assistant branch), and
- emit a tool wire only when `issuedToolCallIds.has(result.toolCallId)`.

The sweep is Set.add/has only (never throws), clean sequences pass through
byte-identical, and on the image path the guard covers the whole result body
so a dropped orphan never leaks images into the shared user image-flush
message. Verified 13/13 logic simulations in
`.dsh/reports/builder/2026-08-21-llm-deepseek-orphan-sweep-rc2.md`.

**Why it lives outside the repo.** The patch file
`dsh-llm-deepseek-orphan-sweep.patch` targets
`<npm-root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`
in the global npm install of `@deepseek-ai/dsh`. That tree is fully replaced on
every `dsh` upgrade, so the fix (applied manually today, 2026-08-21, after the
rc.1 → rc.2 upgrade) was lost in the upgrade. **Owner decision: fold it as a
repo patch — no upstream PR.**

## Fingerprints (md5)

| What | File (relative) | Bytes | md5 |
|---|---|---|---|
| Pristine `@deepseek-ai/dsh` **0.1.1-rc.2** index.js | `dsh-llm-deepseek/lib/index.js` | 78 334 | `f82d2ea38a6a27ae0c7f691d384b3949` |
| **Patched** (Fix B applied — current installed state) | `dsh-llm-deepseek/lib/index.js` | 78 712 | `da90e47fccdeae16f93472159aee0e1c` |
| Historical: rc.1 patched backup (pre-rc.2 upgrade) | `/opt/dsh/backups/llm-deepseek-index.js-pre-rc2-20260821-1328` | 38 331 | `8d23bbe5afd6cb08c7f105817852cf6b` |

Other restoration backups in `/opt/dsh/backups/llm-deepseek-index.js-*`
(`-20260821-1206`, `-20260821-1207`) cover the rc.1-era edit steps.

## Re-running after a dsh upgrade

Every `dsh` upgrade resets the target file to a *pristine* state (or drifts it
further if upstream changed the serializer). Then:

```bash
# 1) Inspect: reports PASS / NOT APPLIED / FAIL
scripts/reapply-dsh-patches.sh --check

# 2) Apply (fingerprint-gated: only touches a pristine rc.2 file)
scripts/reapply-dsh-patches.sh apply
```

`apply` refuses (idempotent, exit 0) when already patched, backs up the target
to `/opt/dsh/backups/llm-deepseek-index.js-pre-<date>-<time>` before patching,
gates on the pristine rc.2 md5, and verifies the result md5 after applying
(restoring the backup on any failure). An explicit `TARGET_FILE` argument
overrides auto-detection; paths under the stable instance home
(`/opt/dsh/.dsh`) are refused unless `--allow-stable` is passed.

> Deployment note: dev (`/opt/dsh/.dsh-dev`, profile `deepartments-dev`) and
> stable (`/opt/dsh/.dsh`) **share the single global dsh CLI install**, so
> there is exactly one lib/index.js to patch and one fingerprint set. A future
> truly separate stable npm tree would need its own fingerprints here.

## When the gate rejects (upstream drifted → manual port)

`--check`/`apply` report **FAIL — upstream drifted** when the target md5
matches neither fingerprint. That means downstream code moved enough that the
patch no longer applies. Do **not** force-apply:

1. Diff the *new* pristine file against this patch's baseline with
   `diff -u /opt/dsh/backups/llm-deepseek-index.js-rc2-pristine-20260821-1332 <new-index.js>`
   and check whether the serializer hunks (`@@ -132…`, `@@ -170…` regions — the
   `wire`/assistant/tool-push lines in both serializers) still match.
2. Port the same three-line sweep pattern (Set + assistant collect + guard) to
   the new file by hand; keep the never-throw semantics and the preceding-
   issuance rule.
3. Regenerate the patch: `diff -u <new-pristine> <new-patched>` → replace
   the body of `patches/dsh-llm-deepseek-orphan-sweep.patch` (keep the
   relative `a/lib/index.js` / `b/lib/index.js` headers and this document's
   header block).
4. Update **this README** and the fingerprints in
   `scripts/reapply-dsh-patches.sh` (`MD5_PRISTINE_RC2`, `MD5_PATCHED`), then
   re-run `--check` → `apply` on the real install and the throwaway-copy test
   below.

## Verification (how this patch is proven, per acceptance of 2026-08-21)

- `scripts/reapply-dsh-patches.sh --check` on the live install → **PASS**
  (md5 `da90e47f…`).
- Throwaway-copy test: copy a pristine rc.2 file to a temp path, `apply` that
  path, md5 becomes `da90e47f…`, then delete the temp — the real install and
  the stable tree are never touched by the test.
- `patch --dry-run -p1` of the patch file against a pristine copy → applies
  cleanly.