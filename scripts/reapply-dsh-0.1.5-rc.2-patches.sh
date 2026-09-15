#!/usr/bin/env bash
#
# reapply-dsh-0.1.5-rc.2-patches.sh - re-apply the Deepartments maintenance
# patches to a VERSIONED 0.1.5-rc.2 tree (deepartments-dev deployment target).
#
# SHAPE (owner's precedent, /opt/dsh/reapply-patch.sh):
#   grep -q '<context>' "$F"  ->  ABSENT : LOUD message + record CONTEXT-ABSENT
#                              ->  PRESENT: edit ANCHORED TO THE CONTEXT LINE
#                                          (never a bare global `s///`), then
#                                          verify the post-state md5.
# Never force: a patch applied by drag is worse than none. The script exits 1
# if ANY row is not fully applied.
#
# IDEMPOTENT: every block first asks "is the POST state already here?" and, if
# so, reports NOOP and does nothing. Re-running twice is the same state and no
# error. (Measured: raw `patch` is NOT idempotent on these files — a second run
# produced md5 546dd082…, neither pristine nor applied — which is exactly why
# the gate is a grep on the CONTEXT, not a blind re-apply.)
#
# SOURCES OF THE ROW DATA (all measured, none invented):
#   - scripts/reapply-dsh-patches-a-harness.sh   (the A-HARNESS chain table)
#   - scripts/reapply-dsh-patches.sh             (the llm-deepseek ladder)
#   - patches/deepartments-maintenance.tsv       (the 4 TSV rows)
#   - the .patch files themselves                (context + expected md5)
#   - the 0.1.5-rc.2 tree                        (measured pre-state md5)
#
# ENGINEERING DEVIATION (DECLARED, not hidden — see the report §spec deviations):
#   The owner's precedent edits ONE line with one anchored `sed`, so it needs a
#   one-line context. Several patches here are MULTI-HUNK (llm-deepseek: 6
#   hunks; tool-fs-search: 8) and cannot be expressed as one anchored `sed`.
#   Those rows use `patch -p1` WITH `--dry-run` verification against the exact
#   pre-state md5 FIRST, so the edit is still context-verified and still never
#   forced. The single-line rows use the anchored `sed` of the precedent.
#
# Usage:
#   scripts/reapply-dsh-0.1.5-rc.2-patches.sh --check [TREE]
#   scripts/reapply-dsh-0.1.5-rc.2-patches.sh apply   [TREE]
#   TREE defaults to $DSH_DEV_TREE or the canonical path below.
#   --check : REPORT ONLY — THIS MODE NEVER WRITES. It runs each row's own
#             presence gate and, for a row that would land, proves the hunks with
#             `patch --dry-run` (which writes nothing) and reports WOULD-APPLY.
#             A --check run leaves every file BYTE-IDENTICAL to how it found it.
#             States: APPLIED / NOOP / WOULD-APPLY / CONTEXT-ABSENT / SKIP.
#   apply   : apply every row whose context is present; loud+exit 1 otherwise.
#
# (The check-mode wording above is a CONTRACT, not a remark: it was measured
# false once — `--check` applied for real and mutated the tree while its banner
# claimed "rows are REPORTED, not applied". DRY_RUN below is the enforcement.)
#
set -euo pipefail

# The deployment tree. MEASURED 2026-09-15: the 0.1.5-rc.2 tree lives at
# /opt/dsh/trees/deepartments-dev-0.1.5-rc.2 — the path the host moved it TO.
# The previous value pointed at the pre-move location (/opt/dsh/.dsh-dev/trees/…),
# which no longer exists: a pointer that had stopped pointing at what it believed.
# Keep this in step with the move (DSH_DEV_TREE still overrides).
CANONICAL_TREE="/opt/dsh/trees/deepartments-dev-0.1.5-rc.2"
TREE="${DSH_DEV_TREE:-${CANONICAL_TREE}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_DIR="${REPO_ROOT}/patches"
MODE="${1:---check}"
[[ $# -ge 1 ]] && shift
[[ $# -ge 1 ]] && TREE="$1"

N="${TREE}/node_modules"
[[ -d "${N}" ]] || { echo "FATAL: no node_modules under ${TREE}" >&2; exit 1; }

md5_of() { md5sum "$1" 2>/dev/null | cut -d' ' -f1; }

# --- the check/apply SEPARATION (B1) ---------------------------------------
# EVERY write in this script is funnelled through DRY_RUN:
#   DRY_RUN=1 (--check) : no write path is reachable. `patch` runs with
#                         --dry-run ONLY (writes nothing), and the two anchored
#                         `sed -i` inserts are skipped after their gates pass.
#                         A row that would land is reported WOULD-APPLY.
#   DRY_RUN=0 (apply)   : the real writes happen.
# MEASURED DEFECT this exists to kill: the check mode used to run its rows
# un-gated, so a `--check` MUTATED the tree (it applied) while the banner
# promised "rows are REPORTED, not applied" — a prudent operator using --check
# precisely to avoid touching the tree was, without knowing it, deploying.
DRY_RUN=1
[[ "${MODE}" == "apply" ]] && DRY_RUN=0
# NOTE: `patch` has NO short form for --dry-run (`-D` is --ifdef, a DIFFERENT and
# file-rewriting option — never use it here). This is the ONLY dry-run spelling.
DRYFLAG=""
[[ "${DRY_RUN}" -eq 1 ]] && DRYFLAG="--dry-run"

# --- counters ---------------------------------------------------------------
APPLIED=0; NOOP=0; ABSENT=0; BAD=0; WOULD=0
# Set by guarded_patch: the outcome of the last call ("APPLIED" / "WOULD-APPLY"),
# so a caller can label its row from what actually happened rather than assume.
GP_STATE=""

# anchored_sed <file> <context> <sed-expr>
# Applies a `sed` ONLY to lines containing <context> (the owner's precedent:
# a bare global s/// can rewrite a SIBLING fence where the identifier is out of
# scope — see /opt/dsh/reapply-patch.sh:5-10).
anchored_sed() {
  local f="$1" ctx="$2" expr="$3"
  if [[ "${DRY_RUN}" -eq 1 ]]; then return 0; fi
  sed -i "/${ctx}/${expr}" "$f"
}

# guarded_patch <pkgdir> <patchfile> [extra-patch-args...]
#
# THE ANTI-DRAG GATE. GNU `patch` writes the hunks that succeed even when
# others FAIL, so a naive `patch -p1` on a drifted file leaves a FRANKENSTEIN
# that matches neither the pristine nor the applied fingerprint. MEASURED on
# 0.1.5-rc.2: dsh-tool-fs-search/lib/index.js was left at 168d0afd… (after
# path-not-found, 3/6 hunks rejected) and then 5bdb6761… (after grep-scope,
# 1/8 rejected) — neither state is a declared fingerprint, and the NEXT row
# then patched on top of that corruption. This helper makes that impossible:
#
#   (1) `patch --dry-run` FIRST. Unless EVERY hunk would apply, it writes
#       NOTHING and returns 1 — the caller reports CONTEXT-ABSENT.
#   (2) only then apply for real, and force a RESTORE if the post-state cannot
#       be confirmed by the caller's own md5 check.
#
# Returns 0 when the patch was fully applied (or, under DRY_RUN, would be),
# 1 otherwise. NEVER leaves a partially patched file. Under DRY_RUN it writes
# NOTHING at all and sets GP_STATE=WOULD-APPLY instead of APPLIED.
guarded_patch() {
  local dir="$1" pfile="$2"; shift 2
  [[ -f "${pfile}" ]] || { echo "  (patch file missing: ${pfile})" >&2; return 1; }
  if ! ( cd "${dir}" && patch -p1 -f --dry-run "$@" < "${pfile}" ) >/dev/null 2>&1; then
    return 1
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then GP_STATE="WOULD-APPLY"; return 0; fi
  ( cd "${dir}" && patch -p1 -f "$@" < "${pfile}" ) >/dev/null 2>&1 || return 1
  GP_STATE="APPLIED"
  return 0
}

# report_applied <row-name>
# Emits the row's outcome line, HONESTLY labelled: WOULD-APPLY in check mode,
# APPLIED when the bytes were really written. Never let a dry run print APPLIED
# — that label/behaviour mismatch is the defect this file now guards against.
report_applied() {
  if [[ "${GP_STATE}" == "WOULD-APPLY" ]]; then
    echo "WOULD-APPLY  $1 (all hunks would apply; --check wrote NOTHING)"
    WOULD=$((WOULD+1))
  else
    echo "APPLIED      $1"
    APPLIED=$((APPLIED+1))
  fi
}

# row <id> <pkgroot> <relfile> <patchfile> <expect-missing-md5-or-'-'>
# Prints the state; the CALLER applies. Keeps every row's evidence greppable.
state_of() {
  local dir="$1" rel="$2" applied_md5="$3" pristine_md5="$4"
  local cur; cur="$(md5_of "${dir}/${rel}")"
  [[ -z "${cur}" ]] && { echo "MISSING"; return; }
  [[ -n "${applied_md5}" && "${cur}" == "${applied_md5}" ]] && { echo "APPLIED"; return; }
  [[ -n "${pristine_md5}" && "${cur}" == "${pristine_md5}" ]] && { echo "PRISTINE"; return; }
  echo "UNKNOWN"
}

echo "### reapply-dsh-0.1.5-rc.2-patches.sh  mode=${MODE}"
echo "### tree: ${TREE}"
echo

# ===========================================================================
# ROW 1 — dsh-fs-local: edit-DX hints
#   fichero: node_modules/@deepseek-ai/dsh-fs-local/lib/index.js
#   md5: pre 424c540f945117bf63ea28a10ee6ab7b -> post 4696abf96dba760a7c3dabc7b0a7ebb8
#   engine: patch (multi-line body, 1 hunk)
# ===========================================================================
row_fs_local() {
  local dir="${N}/@deepseek-ai/dsh-fs-local" rel="lib/index.js"
  local P="${PATCH_DIR}/dsh-fs-local-edit-dx-hints.patch"
  local PRE=424c540f945117bf63ea28a10ee6ab7b POST=4696abf96dba760a7c3dabc7b0a7ebb8
  local cur; cur="$(md5_of "${dir}/${rel}")"
  if [[ "${cur}" == "${POST}" ]]; then echo "NOOP         dsh-fs-local-edit-dx-hints (already applied)"; NOOP=$((NOOP+1)); return 0; fi
  # the context anchor this patch needs, from the patch body itself
  if ! grep -q 'old_string was not found in' "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-fs-local-edit-dx-hints — 'old_string was not found' not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  ( cd "${dir}" && patch -p1 -f ${DRYFLAG} < "${P}" >/dev/null 2>&1 ) || { echo "FAIL dsh-fs-local-edit-dx-hints (patch rejected)" >&2; BAD=$((BAD+1)); return 1; }
  if [[ "${DRY_RUN}" -eq 1 ]]; then echo "WOULD-APPLY  dsh-fs-local-edit-dx-hints (hunk would apply; --check wrote NOTHING)"; WOULD=$((WOULD+1)); return 0; fi
  [[ "$(md5_of "${dir}/${rel}")" == "${POST}" ]] && { echo "APPLIED      dsh-fs-local-edit-dx-hints"; APPLIED=$((APPLIED+1)); } \
    || { echo "FAIL dsh-fs-local-edit-dx-hints post-md5 $(md5_of "${dir}/${rel}") != ${POST}" >&2; BAD=$((BAD+1)); return 1; }
}

# ===========================================================================
# ROW 2 — dsh-fs-observation-policy: FS_NOT_OBSERVED names session freshness
#   fichero: node_modules/@deepseek-ai/dsh-fs-observation-policy/lib/index.js
#   md5: pre 03a757a7ef920657faf01ab3f959eb1e -> post aeec8df679864aaee3408b2cb8229f03
#   engine: ANCHORED SED (single line — the owner's exact precedent shape)
#   context: `if (!owner || prior === void 0) throw new FsError(`edit requires reading`
# ===========================================================================
row_fs_obs() {
  local dir="${N}/@deepseek-ai/dsh-fs-observation-policy" rel="lib/index.js"
  local PRE=03a757a7ef920657faf01ab3f959eb1e POST=aeec8df679864aaee3408b2cb8229f03
  local cur; cur="$(md5_of "${dir}/${rel}")"
  if [[ "${cur}" == "${POST}" ]]; then echo "NOOP         dsh-fs-observation-policy (already applied)"; NOOP=$((NOOP+1)); return 0; fi
  local ctx='edit requires reading'
  if ! grep -q "${ctx}" "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-fs-observation-policy — '${ctx}' not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  # The context grep above is the GATE (the precedent's form). The edit itself
  # uses `patch` for BYTE-EXACTNESS: an equivalent anchored `sed` was measured
  # to reproduce the INTENT but not the exact bytes (2cf2397a… vs aeec8df6…),
  # and a byte-exact post-state is what the fingerprint check can verify.
  ( cd "${dir}" && patch -p1 -f ${DRYFLAG} < "${PATCH_DIR}/dsh-fs-observation-policy-not-observed-message.patch" >/dev/null 2>&1 ) \
    || { echo "FAIL dsh-fs-observation-policy (patch rejected)" >&2; BAD=$((BAD+1)); return 1; }
  if [[ "${DRY_RUN}" -eq 1 ]]; then echo "WOULD-APPLY  dsh-fs-observation-policy (hunk would apply; --check wrote NOTHING)"; WOULD=$((WOULD+1)); return 0; fi
  [[ "$(md5_of "${dir}/${rel}")" == "${POST}" ]] && { echo "APPLIED      dsh-fs-observation-policy"; APPLIED=$((APPLIED+1)); } \
    || { echo "FAIL dsh-fs-observation-policy post-md5 $(md5_of "${dir}/${rel}") != ${POST}" >&2; BAD=$((BAD+1)); return 1; }
}

# ===========================================================================
# ROW 3 — dsh-tool-fs: edit-DX remedies (FS_EDIT_NOT_FOUND + reworded remedies)
#   fichero: node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js
#   md5: pre 229f3b817c6b2d25669263cc8e8622cc -> post (see patches/README.md)
#   MEASURED 0.1.5: **CONTEXT-ABSENT** — upstream reworded the remedy map
#   ('The remedy appended to each remediable failure code's message' no longer
#   matches; the 0.1.5 file already carries a THIRD wording). NOT ported.
#   => This row's OLD patch (the 0.1.1 REMEDIES-map form) is NOT the one that
#      delivers the 0.1.5 effect. It is KEPT at CONTEXT-ABSENT, UNFORCED
#      (asserted by row_tool_fs_old, which never writes), and the SAME face is
#      delivered by ROW 3B below, re-anchored to the 0.1.5 BRANCH form.
# ===========================================================================
row_tool_fs_old() {
  local dir="${N}/@deepseek-ai/dsh-tool-fs" rel="lib/index.js"
  if ! grep -q 'The remedy appended to each remediable failure code' "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-tool-fs-edit-dx-remedies — upstream rewrote the REMEDIES block in 0.1.5; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-tool-fs-edit-dx-remedies.patch"; then
    report_applied dsh-tool-fs-edit-dx-remedies
  else
    echo "FAIL dsh-tool-fs-edit-dx-remedies" >&2; BAD=$((BAD+1)); return 1;
  fi
}

# ===========================================================================
# ROW 3B — dsh-tool-fs: FS_EDIT_NOT_FOUND edit-DX remedy RE-ANCHORED to the
#          0.1.5 BRANCH form (fb-827) — the re-port of ROW 3's effect.
#   fichero: node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js
#   md5: pre 229f3b817c6b2d25669263cc8e8622cc -> post ca7f5f955d0f2e4a5323b583e781e7cc
#   SOURCE OF THE PRE (in-scope, byte-exact): published npm tarball
#     @deepseek-ai/dsh-tool-fs/-/dsh-tool-fs-0.1.5-rc.2.tgz (md5 1f05fc92…);
#     its package/lib/index.js is 229f3b81… — measured, and corroborated by this
#     script's own ROW 3 header.
#   WHICH ROWS TOUCH THIS FILE: ROW 3 (3B's own predecessor) and 3B only. The
#     0.1.5 CHAIN rows (6..9) and 3b edit a DIFFERENT package
#     (@deepseek-ai/dsh-tool-fs-search), so POST-3b state cannot invalidate this
#     PRE. MEASURED, not assumed.
#   ENGINE: the proven guarded_patch pattern (--dry-run FIRST, apply ONLY if
#     EVERY hunk lands) + a PRESENCE GATE for idempotency.
#   IDEMPOTENCY GATE: `FS_EDIT_NOT_FOUND` is this patch's own signature and its
#     ABSENCE is what makes the patch applicable, so its PRESENCE short-circuits
#     to NOOP. Never re-apply this file blindly (raw `patch` is NOT idempotent
#     on these files — MEASURED elsewhere in this script).
# ===========================================================================
row_tool_fs_remedies() {
  local dir="${N}/@deepseek-ai/dsh-tool-fs" rel="lib/index.js"
  local F="${dir}/${rel}"
  local PRE=229f3b817c6b2d25669263cc8e8622cc
  local POST=ca7f5f955d0f2e4a5323b583e781e7cc
  # -- presence gate FIRST (idempotency): already-applied -> NOOP, no write ----
  if grep -q 'FS_EDIT_NOT_FOUND' "${F}"; then
    # POST fingerprint too: a file carrying the code but not the declared bytes
    # is a silent drift, not a NOOP.
    if [[ "$(md5_of "${F}")" == "${POST}" ]]; then
      echo "NOOP         dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor (already applied)"
      NOOP=$((NOOP+1))
    else
      echo "WARN         dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor — FS_EDIT_NOT_FOUND present but md5 $(md5_of "${F}") != ${POST}; inspect" >&2
      BAD=$((BAD+1)); return 1
    fi
    return 0
  fi
  # -- exact base check: the patch declares an EXACT PRE md5. Any other file is
  #    not this patch's base -> declare, do NOT force (the anti-drag rule).
  if [[ "$(md5_of "${F}")" != "${PRE}" ]]; then
    echo "CONTEXT-ABSENT dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor — md5 $(md5_of "${F}") is not the declared PRE ${PRE}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor.patch"; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      report_applied dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor
    elif [[ "$(md5_of "${F}")" == "${POST}" ]]; then
      report_applied dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor
    else
      echo "FAIL dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor post-md5 $(md5_of "${F}") != ${POST}" >&2
      BAD=$((BAD+1)); return 1
    fi
  else
    echo "CONTEXT-ABSENT dsh-tool-fs-edit-dx-remedies-0.1.5-reanchor — a hunk rejects against the branch-shaped base; NOTHING WRITTEN" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
}

# ===========================================================================
# ROW 4 — dsh-tool-web: web_fetch timeout_ms override
#   fichero: node_modules/@deepseek-ai/dsh-tool-web/lib/index.js (+2 .d.ts)
#   MEASURED 0.1.5: **CONTEXT-ABSENT / partial** — `applyWebFetchTool(ctx,
#   timeoutMs, maxOutputChars)` in 0.1.5 has NO `options` param, so the
#   payload's 5th/6th arguments do not exist. NOT ported.
# ===========================================================================
row_tool_web() {
  local dir="${N}/@deepseek-ai/dsh-tool-web" rel="lib/index.js"
  if ! grep -q 'DEFAULT_FETCH_MAX_TIMEOUT_MS' "${dir}/${rel}" && \
     ! grep -q 'function applyWebFetchTool(ctx, timeoutMs, maxOutputChars, options' "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-tool-web-fetch-timeout-override — 0.1.5 applyWebFetchTool has no options/settings spread; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-tool-web-fetch-timeout-override.patch"; then
    report_applied dsh-tool-web-fetch-timeout-override;
  else
    echo "FAIL dsh-tool-web-fetch-timeout-override" >&2; BAD=$((BAD+1)); return 1;
  fi
}

# ===========================================================================
# ROW 5 — dsh-web: WebFetchRequest.timeoutMs
#   fichero: node_modules/@deepseek-ai/dsh-web/lib/types/types.d.ts
#   md5: pre 622e5d50256c200cc289dbfa35f0b43c -> post f74e2a0b1f4356cfca6fbc157d684020
#   MEASURED: APPLIES CLEANLY. The interface is still `{ readonly url: string }`.
#   engine: ANCHORED SED on the interface member line.
# ===========================================================================
row_web() {
  local dir="${N}/@deepseek-ai/dsh-web" rel="lib/types/types.d.ts"
  local POST=f74e2a0b1f4356cfca6fbc157d684020
  local cur; cur="$(md5_of "${dir}/${rel}")"
  if [[ "${cur}" == "${POST}" ]]; then echo "NOOP         dsh-web-fetch-request-timeout (already applied)"; NOOP=$((NOOP+1)); return 0; fi
  local ctx='readonly url: string;'
  if ! grep -q "${ctx}" "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-web-fetch-request-timeout — '${ctx}' not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  # The context grep above is the GATE. Byte-exact application via `patch`
  # (measured clean: the 0.1.5 WebFetchRequest is still `{ readonly url }`).
  ( cd "${dir}" && patch -p1 -f ${DRYFLAG} < "${PATCH_DIR}/dsh-web-fetch-request-timeout.patch" >/dev/null 2>&1 ) \
    || { echo "FAIL dsh-web-fetch-request-timeout (patch rejected)" >&2; BAD=$((BAD+1)); return 1; }
  if [[ "${DRY_RUN}" -eq 1 ]]; then echo "WOULD-APPLY  dsh-web-fetch-request-timeout (hunk would apply; --check wrote NOTHING)"; WOULD=$((WOULD+1)); return 0; fi
  [[ "$(md5_of "${dir}/${rel}")" == "${POST}" ]] && { echo "APPLIED      dsh-web-fetch-request-timeout"; APPLIED=$((APPLIED+1)); } \
    || { echo "WARN dsh-web-fetch-request-timeout post-md5 $(md5_of "${dir}/${rel}") != ${POST} (anchored sed shape differs; inspect)" >&2; BAD=$((BAD+1)); return 1; }
}

# ===========================================================================
# ROW 6..9 — dsh-tool-fs-search CHAIN (anchor -> path-not-found -> grep-scope
#            -> no-collapse). ORDER MATTERS: each pristine is the previous
#            applied state (see scripts/reapply-dsh-patches-a-harness.sh:143-146).
#   fichero: node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js
#   measured 0.1.5 pre: a143a3d7a0f8533f3f13e40bfe2040c2
#   1 anchor       a143a3d7 -> 36bb46d4  CLEAN
#   2 path-not-fnd 36bb46d4 -> 168d0afd  3/6 hunks REJECT (upstream moved)
#   3 grep-scope   168d0afd -> 5bdb6761  1/8 hunks REJECT
#   3b grep-scope-RE-CLOSURE (fb-765, NEW): its own PRE is the ANCHOR state
#      36bb46d4 -> a182162d  CLEAN (8/8 hunks). It does NOT depend on rows 2/3:
#      row 3 cannot land in 0.1.5, and 3b carries the SAME effect re-anchored to
#      the closure. Row 3 stays declared-as-CONTEXT-ABSENT (never forced) and 3b
#      is what actually restores the scope declaration on 0.1.5.
#   4 no-collapse  5bdb6761 -> c18b8c32  CLEAN (unreachable in 0.1.5; see below)
# ===========================================================================
row_fs_search() {
  local dir="${N}/@deepseek-ai/dsh-tool-fs-search" rel="lib/index.js"
  local F="${dir}/${rel}"
  local P1="${PATCH_DIR}/dsh-tool-fs-search-anchor-literal-glob.patch"
  local P2="${PATCH_DIR}/dsh-tool-fs-search-path-not-found.patch"
  local P3="${PATCH_DIR}/dsh-tool-fs-search-grep-scope-declaration.patch"
  local P3B="${PATCH_DIR}/dsh-tool-fs-search-grep-scope-reclosure.patch"
  local P4="${PATCH_DIR}/dsh-tool-fs-search-no-collapse.patch"
  local rc=0
  # -- 1 anchor: context = the pristine buildGrepCommand shape
  if grep -q 'function anchorGlobPattern' "${F}"; then
    echo "NOOP         dsh-tool-fs-search-anchor-literal-glob (already applied)"
    NOOP=$((NOOP+1))
  elif grep -q -- '--glob=${input.pattern}' "${F}"; then
    if guarded_patch "${dir}" "${P1}"; then
  report_applied dsh-tool-fs-search-anchor-literal-glob;
  else
    echo "FAIL anchor-literal-glob" >&2; BAD=$((BAD+1)); rc=1;
  fi
  else
    echo "CONTEXT-ABSENT dsh-tool-fs-search-anchor-literal-glob" >&2; ABSENT=$((ABSENT+1)); rc=1
  fi
  # -- 2 path-not-found: context = the plain classifyRunFailure (no SEARCH_PATH_NOT_FOUND)
  if grep -q 'SEARCH_PATH_NOT_FOUND' "${F}"; then
    echo "NOOP         dsh-tool-fs-search-path-not-found (already applied)"
    NOOP=$((NOOP+1))
  elif grep -q 'function classifyRunFailure(toolName, exitCode, stderrText, stderrTruncated)' "${F}"; then
    # GUARDED: 3 of 6 hunks reject in 0.1.5, so a plain `patch` would leave a
    # frankenstein (MEASURED: 168d0afd… — not a declared fingerprint).
    if guarded_patch "${dir}" "${P2}"; then
      report_applied dsh-tool-fs-search-path-not-found
    else
      echo "CONTEXT-ABSENT dsh-tool-fs-search-path-not-found — 3/6 hunks reject in 0.1.5 (upstream moved classifyRunFailure + the grep doc block); NOTHING WRITTEN" >&2
      ABSENT=$((ABSENT+1)); rc=1
    fi
  else
    echo "CONTEXT-ABSENT dsh-tool-fs-search-path-not-found" >&2; ABSENT=$((ABSENT+1)); rc=1
  fi
  # -- 3 grep-scope (fb-765): context = the zero-match literal the patch wraps
  if grep -q 'function formatScopeNote' "${F}"; then
    echo "NOOP         dsh-tool-fs-search-grep-scope-declaration (already applied)"
    NOOP=$((NOOP+1))
  elif grep -q 'if (retained.seen === 0) return "No matches found";' "${F}"; then
    # GUARDED: hunk #5 (the systemPrompt text) rejects in 0.1.5.
    if guarded_patch "${dir}" "${P3}"; then
      report_applied dsh-tool-fs-search-grep-scope-declaration
    else
      echo "CONTEXT-ABSENT dsh-tool-fs-search-grep-scope-declaration — hunk #5 (systemPrompt text) rejects in 0.1.5; NOTHING WRITTEN" >&2
      ABSENT=$((ABSENT+1)); rc=1
    fi
  else
    echo "CONTEXT-ABSENT dsh-tool-fs-search-grep-scope-declaration" >&2; ABSENT=$((ABSENT+1)); rc=1
  fi
  # -- 3b grep-scope RE-PORT to the 0.1.5 CLOSURE form (fb-765) --------------
  # The 0.1.5 tree turned `tool:grep` into a scope-dependent CLOSURE
  # (`text: ({ scope }) => …`, PARCH :1124) and DROPPED the trio empty-result /
  # path-not-found / pattern-rejected with it, so row 3 above (written for the
  # 0.1.1 STATIC string) CANNOT land. Row 3b is the SAME effect re-anchored to
  # the closure, with the trio restored inside it.
  #
  # PRE 36bb46d4112901c20bd213d38c088303  ->  POST a182162dd5ef7d2cc299a7d23015c1db
  # (MEASURED in-scope: the published 0.1.5-rc.2 npm tarball + the anchor patch
  # reproduces that PRE byte-exactly, and this patch takes it to that POST with
  # 0 hunks rejected and 0 .rej.)
  #
  # CONTEXT GATE (presence grep, NOT a re-apply): `function formatScopeNote` is
  # this patch's own signature and its ABSENCE is what makes the patch
  # applicable. MEASURED: raw `patch` is NOT idempotent on this file — a second
  # raw run yields 764c9d8c80783eaa8c0d511820d9022e plus one lib/index.js.rej —
  # so the gate MUST short-circuit on the POST state and never re-apply blindly.
  if grep -q 'function formatScopeNote' "${F}"; then
    echo "NOOP         dsh-tool-fs-search-grep-scope-reclosure (already applied)"
    NOOP=$((NOOP+1))
  elif [[ "$(md5_of "${F}")" != "36bb46d4112901c20bd213d38c088303" ]]; then
    # The patch's PRE is an EXACT md5 (the anchor state). Any other file is not
    # this patch's base: declare and do NOT force (the anti-drag rule).
    echo "CONTEXT-ABSENT dsh-tool-fs-search-grep-scope-reclosure — md5 $(md5_of "${F}") is not the declared PRE 36bb46d4…; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); rc=1
  elif guarded_patch "${dir}" "${P3B}"; then
    # POST fingerprint: the patch declares a182162dd5ef7d2cc299a7d23015c1db. A
    # full-hunk apply that does NOT reproduce it is a silent drift, not success.
    # UNDER --check NOTHING was written, so the file is still at its PRE by
    # construction — the fingerprint check is meaningful only when bytes moved.
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      report_applied dsh-tool-fs-search-grep-scope-reclosure
    elif [[ "$(md5_of "${F}")" == "a182162dd5ef7d2cc299a7d23015c1db" ]]; then
      report_applied dsh-tool-fs-search-grep-scope-reclosure
    else
      echo "FAIL dsh-tool-fs-search-grep-scope-reclosure post-md5 $(md5_of "${F}") != a182162dd5ef7d2cc299a7d23015c1db" >&2
      BAD=$((BAD+1)); rc=1
    fi
  else
    echo "CONTEXT-ABSENT dsh-tool-fs-search-grep-scope-reclosure — a hunk rejects against the closure-shaped base; NOTHING WRITTEN" >&2
    ABSENT=$((ABSENT+1)); rc=1
  fi
  # -- 4 no-collapse: context = the collapsed 'the search target' literal.
  # Its PRISTINE is the path-not-found-APPLIED state; when path-not-found did
  # not land, no-collapse is NOT applied (it would edit a file that is not its
  # base) — SKIP, never force.
  if grep -q 'const named = searchTarget' "${F}"; then
    echo "NOOP         dsh-tool-fs-search-no-collapse (already applied)"
    NOOP=$((NOOP+1))
  elif [[ "$(md5_of "${F}")" == "36bb46d4112901c20bd213d38c088303" ]]; then
    # anchor-only state: the no-collapse base is absent -> declare, do not force.
    echo "SKIP         dsh-tool-fs-search-no-collapse (its pristine, the path-not-found-applied state, is not reachable in 0.1.5)" >&2
    ABSENT=$((ABSENT+1)); rc=1
  else
    echo "SKIP         dsh-tool-fs-search-no-collapse (prerequisite path-not-found not applied)" >&2
    ABSENT=$((ABSENT+1)); rc=1
  fi
  return ${rc}
}

# ===========================================================================
# ROW 10 — dsh-app-boot: watchUserPatchLayers
#   fichero: node_modules/@deepseek-ai/dsh-app-boot/lib/index.js (+types)
#   MEASURED 0.1.5: hunk #1 applies (offset 348), hunk#2 REJECTS; the export
#   list does NOT contain watchUserPatchLayers. Partial -> NOT ported.
# ===========================================================================
row_app_boot() {
  local dir="${N}/@deepseek-ai/dsh-app-boot" rel="lib/index.js"
  if grep -q 'DEFAULT_PROFILE_PATCH_RELOAD' "${dir}/${rel}" && ! grep -q 'function watchUserPatchLayers' "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-app-boot-watch-patch-layers — 0.1.5 ships DEFAULT_PROFILE_PATCH_RELOAD (the upstream drift the patch predates); NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  echo "SKIP         dsh-app-boot-watch-patch-layers (see report: partial in 0.1.5)" >&2
  ABSENT=$((ABSENT+1)); return 1
}

# ===========================================================================
# ROW 11 — dsh-client-ui-conversation: message-identity fallback
#   fichero: node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
#   MEASURED 0.1.5: **CONTEXT-ABSENT** — hunk #1 (line 8606) REJECTS; the
#   'input-message' definition the patch edits is not at that anchor in 0.1.5.
# ===========================================================================
row_client_ui() {
  local dir="${N}/@deepseek-ai/dsh-client-ui-conversation" rel="lib/client.js"
  if grep -q 'id: event.data.id === void 0 ? String(event.seq)' "${dir}/${rel}"; then
    echo "NOOP         dsh-client-ui-conversation-input-message-identity (already applied)"; return 0
    NOOP=$((NOOP+1))
  fi
  if ! grep -q 'input-message' "${dir}/${rel}"; then
    echo "CONTEXT-ABSENT dsh-client-ui-conversation-input-message-identity — the 'input-message' definition moved in 0.1.5; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-client-ui-conversation-input-message-identity.patch"; then
    report_applied dsh-client-ui-conversation-input-message-identity;
  else
    echo "CONTEXT-ABSENT dsh-client-ui-conversation-input-message-identity (hunk rejected); NOT forcing" >&2; ABSENT=$((ABSENT+1)); return 1;
  fi
}

# ===========================================================================
# ROW 12-13 — dsh-llm-deepseek LADDER (orphan sweep -> toolcall strip)
#   fichero: node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
#   measured 0.1.5 pre: 8ffe35ce90c5bd3e8b120e299983a501
#   both stages APPLY CLEANLY (offsets +1/-1/-3 = upstream drift in unrelated
#   regions). These are the 400-class serializers.
# ===========================================================================
row_llm_deepseek() {
  local dir="${N}/@deepseek-ai/dsh-llm-deepseek" rel="lib/index.js"
  local F="${dir}/${rel}"
  if grep -q 'issuedToolCallIds' "${F}"; then
    echo "NOOP         dsh-llm-deepseek-orphan-sweep (already applied)"
    NOOP=$((NOOP+1))
  elif grep -q 'for (const result of toolResults) wire.push({' "${F}"; then
    if guarded_patch "${dir}" "${PATCH_DIR}/dsh-llm-deepseek-orphan-sweep.patch"; then
    report_applied dsh-llm-deepseek-orphan-sweep;
  else
    echo "FAIL dsh-llm-deepseek-orphan-sweep" >&2; BAD=$((BAD+1)); return 1;
  fi
  else
    echo "CONTEXT-ABSENT dsh-llm-deepseek-orphan-sweep" >&2; ABSENT=$((ABSENT+1)); return 1
  fi
  if grep -q 'function stripIncompleteToolCalls' "${F}"; then
    echo "NOOP         dsh-llm-deepseek-toolcall-strip (already applied)"
    NOOP=$((NOOP+1))
  else
    if guarded_patch "${dir}" "${PATCH_DIR}/dsh-llm-deepseek-toolcall-strip.patch"; then
    report_applied dsh-llm-deepseek-toolcall-strip;
  else
    echo "FAIL dsh-llm-deepseek-toolcall-strip" >&2; BAD=$((BAD+1)); return 1;
  fi
  fi
}

# ===========================================================================
# ROW 14 — dsh-compaction-basic: fb-251 bare-400 guard (the NAMED 400 guard)
#   fichero: node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js
#   measured 0.1.5 pre: b02f77134e95d5ac6dad... (see report)
#   measured 0.1.5 post: 4adc4cbc1ce2e9263c328d9c2f734b93
#   hunk #2 (the real guard) APPLIES at offset +18; hunk #1 (the const beside
#   the import block) REJECTS because 0.1.5's import list changed. The guard
#   line is what carries the effect -> applied via ANCHORED insertion on the
#   `agent/request-error` context line (the owner's precedent shape).
# ===========================================================================
row_compaction() {
  local dir="${N}/@deepseek-ai/dsh-compaction-basic" rel="lib/index.js"
  local F="${dir}/${rel}" POST=4adc4cbc1ce2e9263c328d9c2f734b93
  # IDEMPOTENCY GATE FIRST (MEASURED defect: the earlier anchored-insert version
  # re-inserted the guard on every run — run 2 produced TWO guard lines and md5
  # 5b1938cf… instead of NOOP). The presence of the const OR the guard call is
  # the "already applied" signal; only a file with NEITHER is patched.
  if grep -q 'BARE400_NO_BODY_RE' "${F}"; then
    echo "NOOP         dsh-compaction-basic-fb251-bare400-guard (already applied)"; return 0
    NOOP=$((NOOP+1))
  fi
  local ctx='if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();'
  if ! grep -qF "${ctx}" "${F}"; then
    echo "CONTEXT-ABSENT dsh-compaction-basic-fb251-bare400-guard — '${ctx}' not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  local ictx='import { isDeepStrictEqual } from "node:util";'
  if ! grep -qF "${ictx}" "${F}"; then
    echo "CONTEXT-ABSENT dsh-compaction-basic-fb251-bare400-guard — the import anchor is not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  # The guard line, ANCHORED to the request-error context line (the precedent's
  # shape: sed is scoped to the line that carries the context, never a global
  # s///). BOTH inserts are WRITES: under --check they are SKIPPED and the row
  # reports WOULD-APPLY (the gates above are what make that a sound report).
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "WOULD-APPLY  dsh-compaction-basic-fb251-bare400-guard (both anchors present; --check wrote NOTHING)"
    WOULD=$((WOULD+1)); return 0
  fi
  sed -i "/$(printf '%s' "${ctx}" | sed 's/[][\.*^$/]/\\&/g')/a\\
\t\t\tif (BARE400_NO_BODY_RE.test(failure.message)) return next();" "${F}"
  # The const, ANCHORED to the last import line.
  sed -i "/$(printf '%s' "${ictx}" | sed 's/[][\.*^$/]/\\&/g')/a\\
const BARE400_NO_BODY_RE = /^4(?:00|13)\\\\s*(?:status code)?\\\\s*\\\\(no body\\\\)/i;" "${F}"
  if grep -q 'BARE400_NO_BODY_RE.test(failure.message)' "${F}"; then
    echo "APPLIED      dsh-compaction-basic-fb251-bare400-guard (anchored insert; post-md5 $(md5_of "${F}"))"
    APPLIED=$((APPLIED+1))
  else
    echo "FAIL dsh-compaction-basic-fb251-bare400-guard (anchor insert did not take)" >&2; BAD=$((BAD+1)); return 1
  fi
}

# ===========================================================================
# ROW 15 — pi-ai bare-400 overflow classifier (the OTHER named 400 guard)
#   fichero: node_modules/@earendil-works/pi-ai/dist/utils/overflow.js
#   measured 0.1.5 pre: 65c4fa80887dee6eda7133916c7208e2
#   measured 0.1.5 post: 26189ad4cc510c1fd1de746464c7eedb  (APPLIES CLEANLY)
#   ANCHORED SED on the bare-nobody regex line (the exact defect line).
# ===========================================================================
row_pi_ai_overflow() {
  local dir="${N}/@earendil-works/pi-ai" rel="dist/utils/overflow.js"
  local F="${dir}/${rel}" POST=26189ad4cc510c1fd1de746464c7eedb
  if [[ "$(md5_of "${F}")" == "${POST}" ]]; then
    echo "NOOP         dsh-pi-ai-fb251-bare400-overflow (already applied)"; return 0
    NOOP=$((NOOP+1))
  fi
  local ctx='/^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i'
  if ! grep -qF '/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i' "${F}"; then
    echo "CONTEXT-ABSENT dsh-pi-ai-fb251-bare400-overflow — the bare no-body pattern is not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-pi-ai-fb251-bare400-overflow.patch"; then
    report_applied dsh-pi-ai-fb251-bare400-overflow;
  else
    echo "FAIL dsh-pi-ai-fb251-bare400-overflow" >&2; BAD=$((BAD+1)); return 1;
  fi
}

# ===========================================================================
# ROW 16 — pi-ai dead partial parse (O(n^2) removal)
#   fichero: node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
#   measured 0.1.5 pre: 6afba0e4a648351e4265231204be4339 (APPLIES CLEANLY, offset 62)
# ===========================================================================
row_pi_ai_parse() {
  local dir="${N}/@earendil-works/pi-ai" rel="dist/api/openai-completions.js"
  local F="${dir}/${rel}"
  if grep -q 'LOCAL PATCH (deepartments 2026-09-10)' "${F}"; then
    echo "NOOP         dsh-pi-ai-dead-partial-parse (already applied)"; return 0
    NOOP=$((NOOP+1))
  fi
  if ! grep -q 'block.arguments = parseStreamingJson(block.partialArgs);' "${F}"; then
    echo "CONTEXT-ABSENT dsh-pi-ai-dead-partial-parse — the per-delta parse line is not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-pi-ai-dead-partial-parse.patch"; then
    report_applied dsh-pi-ai-dead-partial-parse;
  else
    echo "FAIL dsh-pi-ai-dead-partial-parse" >&2; BAD=$((BAD+1)); return 1;
  fi
}

# ===========================================================================
# ROW 17 — dsh-session-persistence-jsonl: parallel listArtifacts (0.1.1 form)
#   fichero: node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
#   measured 0.1.5 pre: 9f672813da6eafbd8f9f7625c0548b3d
#   NOTE: the patch header path is NESTED
#   (`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/...`) because it
#   was written for the 0.1.1 GLOBAL tree; the 0.1.5 tree is FLAT, so it must be
#   applied with `-p1` FROM the tree root (measured: hunk#1 fuzz-applies,
#   hunk#2 REJECTS -> partial). NOT ported.
#   => This row is KEPT at CONTEXT-ABSENT, UNFORCED (mission condition 2). The
#      SAME effect is delivered by ROW 17B below, re-anchored to the 0.1.5 form.
# ===========================================================================
row_session_persist() {
  local rel="node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js"
  local F="${TREE}/${rel}"
  if ! grep -q 'for (const dir of await this.listSessionDirs(project, signal))' "${F}"; then
    echo "CONTEXT-ABSENT dsh-session-persistence-list-parallel — the serial loop shape is not in ${rel}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  # GUARDED with -p1 FROM THE TREE ROOT: the patch header carries the NESTED
  # 0.1.1 path (`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/...`)
  # while the 0.1.5 tree is FLAT — so the strip level depends on the root. The
  # dry-run gate is what stops hunk#1's fuzz-apply from landing while hunk#2
  # rejects (the measured frankenstein: 9f672813 -> partial + a stray .rej).
  if guarded_patch "${TREE}" "${PATCH_DIR}/dsh-session-persistence-list-parallel.patch" -p1; then
    report_applied dsh-session-persistence-list-parallel
  else
    echo "CONTEXT-ABSENT dsh-session-persistence-list-parallel — hunk#2 rejects in the flat 0.1.5 tree; NOTHING WRITTEN" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
}

# ===========================================================================
# ROW 17B — dsh-session-persistence-jsonl: bounded-concurrency listArtifacts,
#           RE-ANCHORED to the 0.1.5 FLAT form (the re-port of ROW 17's effect)
#   fichero: node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
#   md5: pre 9f672813da6eafbd8f9f7625c0548b3d -> post 6fc06bfb4fb64ce664331a80af5f9c0f
#   SOURCE OF THE PRE (in-scope, byte-exact): published npm tarball
#     @deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.1.5-rc.2.tgz
#     (tarball md5 ff2a41ae9258335592aad6ade2fd4ba4); its package/lib/index.js is
#     9f672813… — measured, and corroborated by ROW 17's own header above.
#   WHICH ROWS TOUCH THIS FILE: ROW 17 (17B's own predecessor) and 17B only.
#     ROW 17 is CONTEXT-ABSENT on 0.1.5 and returns 1 at its context grep (:664)
#     without ever reaching guarded_patch, so it cannot invalidate this PRE.
#     NO other row resolves to this package. MEASURED, not assumed.
#   ENGINE: the proven guarded_patch pattern (--dry-run FIRST, apply ONLY if
#     EVERY hunk lands) + a PRESENCE GATE for idempotency + an EXACT PRE md5 check.
#   -p1 FROM THE PACKAGE DIRECTORY, header paths `a/lib/index.js`/`b/lib/index.js`
#     (the ROW 3B shape): the 0.1.5 tree is FLAT and the 0.1.1 nested header is
#     NOT used here — that nested-path row stays CONTEXT-ABSENT above.
#   IDEMPOTENCY GATE: `LOCAL PATCH (deepartments): bounded-concurrency session
#     probe` is this patch's own signature and its ABSENCE is what makes the patch
#     applicable, so its PRESENCE short-circuits to NOOP. Never re-apply this file
#     blindly (raw `patch` is NOT idempotent on these files — MEASURED elsewhere
#     in this script; MEASURED for THIS file too: run 2 would ADD A SECOND patch
#     body on top of the first and leave a .rej).
#   EFFECT (measured by EXECUTION, not by exit code): the resulting listArtifacts
#     probes the session directories with up to 64 in flight (observed
#     max-in-flight 64) against the pristine's serial 1 — the 2 870 ms -> 794 ms
#     (3,6x) face on 2 420 sessions. Re-measured on a 200-dir/5 ms fixture:
#     1 092 ms serial -> 23,9 ms patched, with the directory ORDER and the
#     duplicate-id message BYTE-IDENTICAL to the pristine.
# ===========================================================================
row_session_persist_reanchor() {
  local dir="${N}/@deepseek-ai/dsh-session-persistence-jsonl" rel="lib/index.js"
  local F="${dir}/${rel}"
  local PRE=9f672813da6eafbd8f9f7625c0548b3d
  local POST=6fc06bfb4fb64ce664331a80af5f9c0f
  # -- presence gate FIRST (idempotency): already-applied -> NOOP, no write ----
  if grep -q 'LOCAL PATCH (deepartments): bounded-concurrency session probe' "${F}"; then
    # POST fingerprint too: a file carrying the marker but not the declared bytes
    # is a silent drift, not a NOOP.
    if [[ "$(md5_of "${F}")" == "${POST}" ]]; then
      echo "NOOP         dsh-session-persistence-list-parallel-0.1.5-reanchor (already applied)"
      NOOP=$((NOOP+1))
    else
      echo "WARN         dsh-session-persistence-list-parallel-0.1.5-reanchor — the bounded-concurrency marker is present but md5 $(md5_of "${F}") != ${POST}; inspect" >&2
      BAD=$((BAD+1)); return 1
    fi
    return 0
  fi
  # -- exact base check: the patch declares an EXACT PRE md5. Any other file is
  #    not this patch's base -> declare, do NOT force (the anti-drag rule).
  if [[ "$(md5_of "${F}")" != "${PRE}" ]]; then
    echo "CONTEXT-ABSENT dsh-session-persistence-list-parallel-0.1.5-reanchor — md5 $(md5_of "${F}") is not the declared PRE ${PRE}; NOT forcing" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
  if guarded_patch "${dir}" "${PATCH_DIR}/dsh-session-persistence-list-parallel-0.1.5-reanchor.patch"; then
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      report_applied dsh-session-persistence-list-parallel-0.1.5-reanchor
    elif [[ "$(md5_of "${F}")" == "${POST}" ]]; then
      report_applied dsh-session-persistence-list-parallel-0.1.5-reanchor
    else
      echo "FAIL dsh-session-persistence-list-parallel-0.1.5-reanchor post-md5 $(md5_of "${F}") != ${POST}" >&2
      BAD=$((BAD+1)); return 1
    fi
  else
    echo "CONTEXT-ABSENT dsh-session-persistence-list-parallel-0.1.5-reanchor — a hunk rejects against the 0.1.5 form; NOTHING WRITTEN" >&2
    ABSENT=$((ABSENT+1)); return 1
  fi
}

# --- run every row; a failing row never aborts the sweep (we report ALL) ----
# BOTH modes run the SAME row set. The old split silently DROPPED row_fs_local
# from --check, so a check run reported an incomplete picture — a check must see
# exactly what apply would do. (What differs between the modes is only whether a
# write is reachable: DRY_RUN.)
run_row() { "$@" || true; }
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "(--check) REPORT ONLY — this run writes NOTHING; a row that would land is reported WOULD-APPLY."
  echo "(--check) run 'apply' to actually patch."
fi
run_row row_fs_local;        run_row row_fs_obs
run_row row_tool_fs_old;     run_row row_tool_fs_remedies
run_row row_tool_web
run_row row_web;             run_row row_fs_search
run_row row_app_boot;        run_row row_client_ui
run_row row_llm_deepseek;    run_row row_compaction
run_row row_pi_ai_overflow;  run_row row_pi_ai_parse
run_row row_session_persist
run_row row_session_persist_reanchor

echo
echo "### summary: applied=${APPLIED} would-apply=${WOULD} noop=${NOOP} context-absent/skipped=${ABSENT} failed=${BAD}"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "### (--check) WROTE NOTHING — applied=${APPLIED} must be 0 in this mode; would-apply=${WOULD} is what 'apply' would land."
  # A non-zero `applied` here would mean a write escaped the DRY_RUN gate: that
  # is the B1 contract broken, and it must be LOUD, not a footnote.
  if [[ "${APPLIED}" -gt 0 ]]; then
    echo "### CONTRACT VIOLATION: --check reported applied=${APPLIED} — a write escaped DRY_RUN." >&2
    exit 2
  fi
fi
if [[ "${ABSENT}" -gt 0 || "${BAD}" -gt 0 ]]; then
  echo "### NOT fully re-applied on 0.1.5-rc.2 — the rows above are the measurement." >&2
  exit 1
fi
echo "### every row applied."
