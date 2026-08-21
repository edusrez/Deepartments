# dsh-deepartments maintenance patches

The `dsh-deepartments` bundle sometimes needs fixes that cannot live inside the
repo's `src/` (they modify the *installed* DeepSeek Harness tree, which ships
from npm). Those fixes are kept here as **versioned patches** with a
fingerprint-gated re-apply script, so they survive `dsh` upgrades without
manual re-application.

The patches form a **staged chain** over
`@deepseek-ai/dsh-llm-deepseek/lib/index.js`:

| Stage | Patch | Effect | From | To |
|---|---|---|---|---|
| 1 | `dsh-llm-deepseek-orphan-sweep.patch` | Orphan `role:'tool'` sweep (Fix B) in both serializers | pristine rc.2 | `da90e47f…` |
| 2 | `dsh-llm-deepseek-toolcall-strip.patch` | Tool-call consecutiveness strip in both serializers | `da90e47f…` | `3390675e…` |

## Stage 1 — dsh-llm-deepseek orphan role:'tool' sweep

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
every `dsh` upgrade, so the fix (applied manually 2026-08-21, after the rc.1 →
rc.2 upgrade) was lost in the upgrade. **Owner decision: fold it as a repo
patch — no upstream PR.**

## Stage 2 — dsh-llm-deepseek tool-call consecutiveness strip

**Problem.** The stage-1 sweep only drops *orphaned tool messages* (ids never
issued). The strict DeepSeek validator also demands the inverse: tool
responses must **consecutively** follow the assistant message that issued the
`tool_calls` (one immediate set — no interleaved user/system messages). A
`dept_sleep` close under Fix A can leave
`[assistant(tool_calls) → user(journal) → tool(result)]` on the wire (the
deferred sleep-replace map is in-memory and empty after a process restart), so
the journal-interleaved tool message — whose id *was* issued — survives the
stage-1 sweep, and the validator rejects the interleave with a 400
`insufficient tool messages following tool_calls`.

**Fix.** A defense-in-depth post-pass in both serializers of the installed
`@deepseek-ai/dsh-llm-deepseek` lib, applied **after** the stage-1 sweep
(`stripIncompleteToolCalls`, called just before both `return wire;`):

- for each assistant wire message with `tool_calls`, collect the tool response
  ids that follow it **consecutively** (until the first non-tool message);
- if **any** `tool_call_id` lacks its consecutive tool response (missing,
  partial, or separated by a user/system message), **strip the whole
  `tool_calls` array** from that assistant (its text/reasoning content is
  kept — the message stays a valid plain assistant message), and
- drop the tool responses of the stripped calls (they would otherwise be
  orphaned `{role:'tool'}` messages — the stage-1 400 class).

Clean consecutive pairs pass through **byte-identical** (never mutated). The
strip is forward-compatible with any future producer of half-pairs and makes
it impossible for *this* 400 class to reach the API from either serializer.
Verified by the extraction probe in
`.dsh/reports/builder/2026-08-21-patch-toolcall-strip.md` (9/9 assertions,
including the exact wake-12 interleaved shape on both paths).

## Fingerprints (md5)

| What | File (relative) | Bytes | md5 |
|---|---|---|---|
| Pristine `@deepseek-ai/dsh` **0.1.1-rc.2** index.js | `dsh-llm-deepseek/lib/index.js` | 78 334 | `f82d2ea38a6a27ae0c7f691d384b3949` |
| **Stage 1** (orphan sweep applied) — stage-2 base | `dsh-llm-deepseek/lib/index.js` | 78 712 | `da90e47fccdeae16f93472159aee0e1c` |
| **Stage 2** (tool-call strip applied — current installed state) | `dsh-llm-deepseek/lib/index.js` | 78 739 | `3390675e5d48a82fe906ba365d91713f` |
| Historical: rc.1 patched backup (pre-rc.2 upgrade) | `/opt/dsh/backups/llm-deepseek-index.js-pre-rc2-20260821-1328` | 38 331 | `8d23bbe5afd6cb08c7f105817852cf6b` |
| Historical: rc.2 pristine (post-upgrade, pre-patch) | `/opt/dsh/backups/llm-deepseek-index.js-rc2-pristine-20260821-1332` | 78 334 | `f82d2ea38a6a27ae0c7f691d384b3949` |

Restoration backups in `/opt/dsh/backups/llm-deepseek-index.js-*` (the
`-pre-<date>-<time>-stage-N` files are per-stage pre-apply snapshots; earlier
entries cover the rc.1-era edit steps).

## Re-running after a dsh upgrade

Every `dsh` upgrade resets the target file to a *pristine* state (or drifts it
further if upstream changed the serializer). Then:

```bash
# 1) Inspect: reports PASS / PARTIAL / NOT APPLIED / FAIL
scripts/reapply-dsh-patches.sh --check

# 2) Apply (fingerprint-gated; chains stage 1 then stage 2)
scripts/reapply-dsh-patches.sh apply
```

`--check` states (exit 0 for every *known* state, exit 1 only for drift):

- **PASS** — stages 1+2 fully applied (md5 `3390675e…`).
- **PARTIAL** — only stage 1 applied (md5 `da90e47f…`); run `apply` to add
  stage 2. (This is the state of the live install right before stage 2 was
  shipped — `apply` upgrades it in place.)
- **NOT APPLIED** — pristine rc.2 (md5 `f82d2ea3…`); run `apply`.
- **FAIL** — md5 matches no fingerprint; upstream drifted, manual port needed.

`apply` refuses (idempotent, exit 0) when already fully patched, and
fingerprint-gates each stage: pristine → stage 1 → stage 2 (each verified
before the next), or stage-1-only → stage 2. Each stage backs up the target to
`/opt/dsh/backups/llm-deepseek-index.js-pre-<date>-<time>-<stage>` before
patching and verifies the result md5 after (restoring the backup on any
failure). An explicit `TARGET_FILE` argument overrides auto-detection; paths
under the stable instance home (`/opt/dsh/.dsh`) are refused unless
`--allow-stable` is passed.

> Deployment note: dev (`/opt/dsh/.dsh-dev`, profile `deepartments-dev`) and
> stable (`/opt/dsh/.dsh`) **share the single global dsh CLI install**, so
> there is exactly one lib/index.js to patch and one fingerprint set. A future
> truly separate stable npm tree would need its own fingerprints here.

## When the gate rejects (upstream drifted → manual port)

`--check`/`apply` report **FAIL — upstream drifted** when the target md5
matches no fingerprint. That means downstream code moved enough that the
patches no longer apply. Do **not** force-apply:

1. Diff the *new* pristine file against this patch's baseline with
   `diff -u /opt/dsh/backups/llm-deepseek-index.js-rc2-pristine-20260821-1332 <new-index.js>`
   and check whether the serializer hunks (the `wire`/assistant/tool-push
   lines in both serializers) still match.
2. Port **stage 1** first (Set + assistant collect + guard — the three-line
   sweep pattern in both serializers), then **stage 2** (the
   `stripIncompleteToolCalls` helper plus its two calls before both
   `return wire;`). Keep the never-throw semantics; stage-1's rule is
   *preceding issuance*, stage-2's rule is *consecutive follow*.
3. Regenerate both patches: `diff -u <new-stage-N-base> <new-stage-N-patched>`
   → replace the body of the matching `patches/dsh-llm-deepseek-*.patch`
   (keep the relative `a/lib/index.js` / `b/lib/index.js` headers and this
   document's header blocks).
4. Update **this README** and the fingerprints in
   `scripts/reapply-dsh-patches.sh` (`MD5_PRISTINE_RC2`, `MD5_STAGE1`,
   `MD5_STAGE2`), then re-run `--check` → `apply` on the real install and the
   throwaway-copy test below.

## Verification (how the chain is proven, per acceptance of 2026-08-21)

- `scripts/reapply-dsh-patches.sh --check` on the live install → **PASS**
  (md5 `3390675e…`, stages 1+2).
- Throwaway-copy test: copy a pristine rc.2 file to a temp path, `apply` that
  path — stage 1 then stage 2 chain, md5 becomes `3390675e…`, then delete the
  temp — the real install and the stable tree are never touched by the test.
- `patch --dry-run -p1` of each patch file against its base (pristine for
  stage 1, stage-1 file for stage 2) → applies cleanly (no fuzz).
- Serializer probe (`.dsh/reports/builder/2026-08-21-patch-toolcall-strip.md`):
  verbatim-extracted real serializers; interleaved/partial/missing shapes →
  `tool_calls` STRIPPED on both paths; clean consecutive shapes → byte-identical
  to the stage-1 output; 9/9 assertions green.