#!/usr/bin/env bash
#
# reapply-dsh-patches-a-harness.sh - re-apply the A-HARNESS PORT patches
# (VALLE 09-07, builder-173, run token cfc0afac) to the installed dsh tree.
#
# This is the "variant of the precedent" (patches/README.md, stage chain over
# the global npm install): scripts/reapply-dsh-patches.sh owns the
# dsh-llm-deepseek chain (stages 1-2); this script owns the A-HARNESS chain
# (stages 3+), a MULTI-FILE fingerprint-gated chain over the installed
# @deepseek-ai/dsh 0.1.1-rc.2 runtime:
#
#   patches/dsh-fs-local-edit-dx-hints.patch                  dsh-fs-local
#   patches/dsh-fs-observation-policy-not-observed-message.patch dsh-fs-observation-policy
#   patches/dsh-tool-fs-edit-dx-remedies.patch                dsh-tool-fs
#   patches/dsh-tool-web-fetch-timeout-override.patch         dsh-tool-web (+types)
#   patches/dsh-web-fetch-request-timeout.patch               dsh-web (types.d.ts)
#   patches/dsh-tool-fs-search-anchor-literal-glob.patch      dsh-tool-fs-search (+types)
#   patches/dsh-tool-fs-search-path-not-found.patch           dsh-tool-fs-search (SEARCH_PATH_NOT_FOUND
#     class — applied ON TOP of the anchor patch; its pristine fingerprint is
#     the anchor-applied state c1ecd7ac…, applied = 576e8e66…; VALLE 09-08 lane)
#   patches/dsh-tool-fs-search-grep-scope-declaration.patch    dsh-tool-fs-search (GREP
#     SCOPE DECLARATION, fb-765 / D-765-R1: the grep ARGV is NOT changed — honoring
#     .gitignore is the norm, so the fix is that the tool now DECLARES its scope in
#     the output: three bounded `rg --files` listing passes measure how many files
#     were searched and how many ripgrep's ignore rules / the dotfile rule excluded,
#     and every result (including a zero-match one) carries that statement; a pass
#     that cannot complete is reported LOUDLY by error code instead of a silent 0;
#     its pristine fingerprint is the path-not-found-applied state 576e8e66…,
#     applied = d8d4dd68…; VALLE 09-11 lane)
#   patches/dsh-tool-fs-search-fb51-direct-edit-normalize.patch  (ONE-TIME: live
#     direct-edit state -> compiled payload form; the durable patch is the
#     anchor-literal-glob one above, based on the reconstructed pristine)
#   patches/dsh-client-ui-conversation-input-message-identity.patch dsh-client-ui-conversation
#     (GUI history-load fix: messageDefinition identity falls back to event.seq
#     when data.id is undefined — the batch-drain undefined-id class; VALLE
#     09-08 lane, explore-deep-58/9620de90)
#   patches/dsh-app-boot-watch-patch-layers.patch             dsh-app-boot (+types)
#   patches/dsh-cli-profile-boot-watch-patch-layers.patch     dsh CLI lib chunk
#
# Usage:
#   scripts/reapply-dsh-patches-a-harness.sh --check [--allow-stable]
#       PASS            every target is fully patched (applied fingerprints)
#       NOT APPLIED     every target is pristine rc.2 (pristine fingerprints)
#       NORMALIZE       dsh-tool-fs-search is in the 2026-09-02 direct-edit
#                       state (fb-51 legacy); run: ... apply
#       PARTIAL         mixed states across the chain
#       FAIL (exit 1)   a target md5 matches no fingerprint (drifted)
#   scripts/reapply-dsh-patches-a-harness.sh apply [--allow-stable]
#       Fingerprint-gated, grouped per patch file (a multi-file patch applies
#       ONCE): pristine -> patch; direct-edit -> normalization patch
#       (tool-fs-search only); applied -> SKIP (idempotent). Every target is
#       backed up to /opt/dsh/backups before patching and verified after
#       (restore on failure). Refuses targets under /opt/dsh/.dsh unless
#       --allow-stable.
#   scripts/reapply-dsh-patches-a-harness.sh --detect
#       Print the resolved target paths (incl. the auto-located profile-boot
#       chunk) and exit.
#
# The patches are self-contained (--- a/... +++ b/...) and are applied with
# `patch -p1` from the owning package root, so a/ and b/ prefixes strip to the
# runtime-relative lib/ paths.
#
# SYMLINK HARDENING (fb-230, VALLE 09-08): a target lib/ dir (or the dsh
# root's own lib/) may be a SYMLINK (npm/pnpm-style staging, or the A-harness
# fake-root staging of 09-07). GNU patch refuses files that resolve OUTSIDE its
# -d root (O_NOFOLLOW / containment — the historical "can't find file to
# patch" ENOTDIR on every symlinked target), so every target is resolved to
# its REAL path (readlink -f) and the patch applies from the REAL package root:
# md5 classification, backup, verify and restore all operate on the real
# destination. A missing target or a dangling/inconsistent symlink aborts with
# a clear error instead of patch's raw failure. `--detect` shows the logical ->
# real mapping.
#
set -euo pipefail

BACKUP_DIR="${DSH_A_HARNESS_BACKUP_DIR:-/opt/dsh/backups}"
STABLE_HOME="/opt/dsh/.dsh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_DIR="${REPO_ROOT}/patches"

# ---- auto-detect the installed dsh root (the global CLI package) ------------
detect_dsh_root() {
  if [[ -n "${DSH_A_HARNESS_ROOT:-}" ]]; then
    echo "${DSH_A_HARNESS_ROOT}"
    return 0
  fi
  local cli_bin resolved bin_dir npm_g
  cli_bin="$(command -v dsh 2>/dev/null || true)"
  if [[ -n "${cli_bin}" ]]; then
    resolved="$(readlink -f "${cli_bin}" 2>/dev/null || true)"
    if [[ -n "${resolved}" ]]; then
      bin_dir="$(dirname "${resolved}")"          # <root>/@deepseek-ai/dsh/lib
      echo "$(cd "${bin_dir}/.." 2>/dev/null && pwd)"
      return 0
    fi
  fi
  npm_g="$(npm root -g 2>/dev/null || true)"
  if [[ -n "${npm_g}" && -f "${npm_g}/@deepseek-ai/dsh/lib/bin.js" ]]; then
    echo "${npm_g}/@deepseek-ai/dsh"
    return 0
  fi
  return 1
}

detect_profile_boot_chunk() {
  local dsh_root="$1" chunk
  for chunk in "${dsh_root}"/lib/profile-boot-*.js; do
    [[ -f "${chunk}" ]] || continue
    if grep -q 'runProfile' "${chunk}" && grep -q '@deepseek-ai/dsh-app-boot' "${chunk}"; then
      echo "${chunk}"
      return 0
    fi
  done
  return 1
}

md5_of() { md5sum "$1" | awk '{print $1}'; }

# ---- the A-HARNESS chain table ----------------------------------------------
# Format: <pkg-root-rel>:<file>:<patch>:<pristine>:<applied>[:<direct-edit>]
# The pkg-root-rel is relative to the dsh root:
#   node_modules/@deepseek-ai/<pkg>    = a nested harness package
#   lib/...                            = a file of the dsh CLI package itself
A_HARNESS=(
  "node_modules/@deepseek-ai/dsh-fs-local lib/index.js dsh-fs-local-edit-dx-hints.patch 17831cb327664ccb703ad737fd79e18d 28f0034382fe7fe280c75a6a842e6c67"
  "node_modules/@deepseek-ai/dsh-fs-observation-policy lib/index.js dsh-fs-observation-policy-not-observed-message.patch 03a757a7ef920657faf01ab3f959eb1e aeec8df679864aaee3408b2cb8229f03"
  "node_modules/@deepseek-ai/dsh-tool-fs lib/index.js dsh-tool-fs-edit-dx-remedies.patch b6696d35941fc4dcd41fd61c20f38a67 103b0b86d98f7429fd74d5b39109d50e"
  "node_modules/@deepseek-ai/dsh-tool-web lib/index.js dsh-tool-web-fetch-timeout-override.patch b90fbf79fd041b32dc74e68125013302 6ce6bc31cd19d78e87c405bc5defe89f"
  "node_modules/@deepseek-ai/dsh-tool-web lib/types/fetch.d.ts dsh-tool-web-fetch-timeout-override.patch 4359745b89cf3d3c59bd6b7cc0986dba cd99169769dcdb0c1db12a127fd5c055"
  "node_modules/@deepseek-ai/dsh-tool-web lib/types/index.d.ts dsh-tool-web-fetch-timeout-override.patch fa96302d924d32de9df5298538f13093 7116efa682ce8b1978190af135fa8aa6"
  "node_modules/@deepseek-ai/dsh-web lib/types/types.d.ts dsh-web-fetch-request-timeout.patch 622e5d50256c200cc289dbfa35f0b43c f74e2a0b1f4356cfca6fbc157d684020"
  "node_modules/@deepseek-ai/dsh-tool-fs-search lib/index.js dsh-tool-fs-search-anchor-literal-glob.patch 9d92d79d19288c8c3d6f353ff4516923 c1ecd7ac43eaf7923af050eee8249673 669590376ecc9d9e1d9fb9f3531100e2"
  "node_modules/@deepseek-ai/dsh-tool-fs-search lib/index.js dsh-tool-fs-search-path-not-found.patch c1ecd7ac43eaf7923af050eee8249673 576e8e66b7a33e15fff58663c672272f"
  "node_modules/@deepseek-ai/dsh-tool-fs-search lib/index.js dsh-tool-fs-search-grep-scope-declaration.patch 576e8e66b7a33e15fff58663c672272f d8d4dd6860a6cd5102f5ba9a517a06ac"
  "node_modules/@deepseek-ai/dsh-tool-fs-search lib/types/glob.d.ts dsh-tool-fs-search-anchor-literal-glob.patch abb3e1903c42e878cb7bc76cece2ad90 ac12dc59628e934777f224164c5459fd 5d10ebee03e200ad16929e0291206efa"
  "node_modules/@deepseek-ai/dsh-app-boot lib/index.js dsh-app-boot-watch-patch-layers.patch f89b0aa41c566589162295578ebb8749 a4f6123a217ac6f4e4cc7280a0d547dc"
  "node_modules/@deepseek-ai/dsh-app-boot lib/types/index.d.ts dsh-app-boot-watch-patch-layers.patch 5ed502c91a525f05367730f28b10e160 027fdc1cc3b47982027997f7902e2150"
  "node_modules/@deepseek-ai/dsh-client-ui-conversation lib/client.js dsh-client-ui-conversation-input-message-identity.patch 3f0397866d990e6ebb7debe11b715e98 4c5c610391116c6361a437db02cd2ad0"
  "lib CLI_CHUNK dsh-cli-profile-boot-watch-patch-layers.patch 12f9ba5a4400a8e795f1d72254119ffb c359a2f3cb7d912b38bc1c2eb14b40a1"
)
NORM_PATCH="dsh-tool-fs-search-fb51-direct-edit-normalize.patch"

classify() {
  local md5="$1" pristine="$2" applied="$3" direct="${4:-}"
  if [[ "${md5}" == "${applied}" ]]; then echo "APPLIED"; return 0; fi
  if [[ -n "${direct}" && "${md5}" == "${direct}" ]]; then echo "DIRECT_EDIT"; return 0; fi
  if [[ "${md5}" == "${pristine}" ]]; then echo "PRISTINE"; return 0; fi
  echo "UNKNOWN"; return 1
}

# CHAIN-AWARE classify (VALLE 09-08 lane): a target file can carry SEQUENTIAL
# patches (dsh-tool-fs-search lib/index.js: anchor-literal-glob, then
# path-not-found), so a copy that sits at ANOTHER row's chain position is a
# KNOWN state, never the drift FAIL — `others` folds every OTHER row's
# fingerprints for the same relpath as `md5:PHASE,...` pairs (PHASE=APP = that
# row's applied state — my file is already superseded past it; PHASE=PRE =
# that row's pristine/direct — a PRECEDING patch must land first). States:
# APPLIED (mine, or superseded) / DIRECT_EDIT (the legacy direct-edit, needs
# the normalize patch) / PRECEDING (an earlier row's base — the earlier group
# handles it; a pending NOT for check, a skip for apply) / PRISTINE (MY patch
# applies now) / UNKNOWN (drift). With no `others` this behaves EXACTLY like
# classify() — the single-patch rows are untouched.
classify_chain() {
  local md5="$1" pristine="$2" applied="$3" direct="${4:-}" others="${5:-}"
  local pair pmd5 phase
  # OWN fingerprints first: a row's pristine can EQUAL another row's applied
  # (the tool-fs-search pair: the anchor's applied c1ecd7ac… IS the
  # path-not-found row's pristine) — MY patch applies NOW when my pristine
  # matches, before the others' superseded/superfluous positions.
  if [[ "${md5}" == "${applied}" ]]; then echo "APPLIED"; return 0; fi
  if [[ -n "${direct}" && "${md5}" == "${direct}" ]]; then echo "DIRECT_EDIT"; return 0; fi
  if [[ "${md5}" == "${pristine}" ]]; then echo "PRISTINE"; return 0; fi
  if [[ -n "${others}" ]]; then
    IFS=',' read -r -a others_arr <<< "${others%,}"
    for pair in "${others_arr[@]}"; do
      [[ -z "${pair}" ]] && continue
      pmd5="${pair%%:*}"
      phase="${pair##*:}"
      if [[ "${md5}" == "${pmd5}" ]]; then
        if [[ "${phase}" == "APP" ]]; then echo "APPLIED"; return 0; fi
        echo "PRECEDING"; return 0
      fi
    done
  fi
  echo "UNKNOWN"; return 1
}

# Fold every row's fingerprints per TARGET FILE into "abs -> md5:PHASE,…"; the
# per-row `others` csv for classify_chain is the map minus the row's OWN
# fingerprints. The key is the ABSOLUTE path (the bare relpath is NOT unique —
# six packages share `lib/index.js`); a missing CLI chunk keys as "cli:<rel>".
# The global CHAIN_PHASES (declared below) is reset here — NEVER re-declared
# (a function-local `declare -A` would shadow it and leave the global stale).
# `return 0` closes the loop: the EOF read returns 1, and under `set -e` a
# non-zero function return would abort the caller.
declare -A CHAIN_PHASES=()
fill_chain_phases() {
  local dsh_root="$1" abs relpath patch pristine applied direct key
  CHAIN_PHASES=()
  while IFS='|' read -r abs real relpath patch pristine applied direct; do
    key="${abs}"
    [[ -z "${key}" ]] && key="cli:${relpath}"
    CHAIN_PHASES["${key}"]+="${pristine}:PRE,"
    CHAIN_PHASES["${key}"]+="${applied}:APP,"
    [[ -n "${direct}" ]] && CHAIN_PHASES["${key}"]+="${direct}:PRE,"
  done < <(resolve_targets "${dsh_root}")
  return 0
}
chain_others() { # $1=abs-key $2=pristine $3=applied $4=direct
  local csv="${CHAIN_PHASES[$1]:-}"
  csv="${csv//$2:PRE,/}"
  csv="${csv//$3:APP,/}"
  [[ -n "$4" ]] && csv="${csv//$4:PRE,/}"
  printf '%s' "${csv%,}"
}

# resolve each chain entry: prints "abs|real|relpath|patch|pristine|applied|direct"
# — `real` is the readlink -f resolved destination of the target (empty when
# the target is missing or a dangling symlink). All file operations below run
# against the REAL path; the logical `abs` stays the chain-identity key.
resolve_targets() {
  local dsh_root="$1" chunk
  chunk="$(detect_profile_boot_chunk "${dsh_root}" || true)"
  while IFS=' ' read -r pkgroot relpath patch pristine applied direct; do
    local abs real
    if [[ "${relpath}" == "CLI_CHUNK" ]]; then
      if [[ -n "${chunk}" ]]; then abs="${chunk}"; relpath="${chunk#${dsh_root}/}"; else abs=""; relpath="lib/profile-boot-<chunk-missing>.js"; fi
    else
      abs="${dsh_root}/${pkgroot}/${relpath}"
    fi
    real="$(readlink -f "${abs}" 2>/dev/null || true)"
    echo "${abs}|${real}|${relpath}|${patch}|${pristine}|${applied}|${direct:-}"
  done <<< "$(printf '%s\n' "${A_HARNESS[@]}")"
}

check_chain() {
  local dsh_root="$1" saw_applied=0 saw_pristine=0 saw_direct=0 saw_unknown=0
  echo "A-HARNESS chain over: ${dsh_root}"
  fill_chain_phases "${dsh_root}"
  while IFS='|' read -r abs real relpath patch pristine applied direct; do
    local state md5 others
    # The REAL path is the file we fingerprint: it covers symlinked targets
    # (lib -> outer store) and reports dangling ones clearly — never patch's
    # raw ENOTDIR "can't find file to patch".
    if [[ -z "${real}" || ! -f "${real}" ]]; then
      echo "  FAIL:  target not found or dangling symlink for ${relpath} (${abs})" >&2
      return 1
    fi
    md5="$(md5_of "${real}")"
    others="$(chain_others "${abs:-cli:${relpath}}" "${pristine}" "${applied}" "${direct}")"
    state="$(classify_chain "${md5}" "${pristine}" "${applied}" "${direct}" "${others}" || echo UNKNOWN)"
    case "${state}" in
      APPLIED)    saw_applied=1; echo "  PASS:   ${relpath} is patched (${md5})";;
      PRISTINE)   saw_pristine=1; echo "  NOT:    ${relpath} is at the patch base (${md5}) — run apply";;
      PRECEDING)  saw_pristine=1; echo "  NOT:    ${relpath} awaits a PRECEDING patch of this chain (${md5}) — run apply";;
      DIRECT_EDIT) saw_direct=1; echo "  NORM:   ${relpath} is in the fb-51 direct-edit state (${md5}) — run apply (normalize)";;
      *)          saw_unknown=1; echo "  FAIL:   ${relpath} drifted — md5 ${md5} matches no fingerprint (manual port; see patches/README.md)" >&2;;
    esac
  done < <(resolve_targets "${dsh_root}")
  if [[ "${saw_unknown}" -eq 1 ]]; then echo "=> FAIL (drift)"; return 1; fi
  if [[ "${saw_applied}" -eq 1 && "${saw_pristine}" -eq 0 && "${saw_direct}" -eq 0 ]]; then
    echo "=> PASS (fully applied)"
  elif [[ "${saw_applied}" -eq 0 && "${saw_pristine}" -eq 1 && "${saw_direct}" -eq 0 ]]; then
    echo "=> NOT APPLIED (pristine rc.2) — run: $(basename "$0") apply"
  elif [[ "${saw_direct}" -eq 1 ]]; then
    echo "=> NORMALIZE PENDING (fb-51 direct-edit in dsh-tool-fs-search) — run: $(basename "$0") apply"
  else
    echo "=> PARTIAL (mixed states) — run: $(basename "$0") apply"
  fi
  return 0
}

# apply ONE patch group (all files of a patch share one apply root at the
# package dir; the CLI chunk applies from the dsh root).
#
# SYMLINK HARDENING (fb-230): every target is resolved to its REAL path
# (readlink -f, the 2nd record field) — md5 classification, backup, verify and
# restore all run against the real destination. The patch is applied from the
# REAL package root (the real dir containing the package's real lib/): GNU
# patch refuses files that resolve OUTSIDE its -d root (the historical ENOTDIR
# "can't find file to patch" on symlinked targets), so keeping the patched
# files inside the applied root is what makes symlinked staging work.
apply_group() {
  local dsh_root="$1" patch="$2" stamp="$3" pkgroot="" abs real relpath pristine applied direct apply_root
  local files=() any=0
  fill_chain_phases "${dsh_root}"
  while IFS='|' read -r abs real relpath cur_patch pristine applied direct; do
    [[ "${cur_patch}" == "${patch}" ]] || continue
    files+=("${abs}|${real}|${relpath}|${cur_patch}|${pristine}|${applied}|${direct:-}")
  done < <(resolve_targets "${dsh_root}")
  [[ "${#files[@]}" -eq 0 ]] && return 0
  local first_rel first_abs
  IFS='|' read -r first_abs first_real first_rel cur_patch pristine applied direct <<< "${files[0]}"
  local apply_root
  # Derive the LOGICAL apply root from the ABSOLUTE path (the record's relpath
  # is file-only): files under <dsh-root>/lib/* belong to the CLI package
  # (root = the dsh root); files under <dsh-root>/node_modules/@deepseek-ai/<pkg>/*
  # belong to that package (root = the first three path segments after the dsh
  # root). The REAL root is derived below from the logical one.
  if [[ -z "${first_abs}" ]]; then
    echo "FAIL: missing CLI profile-boot chunk (${first_rel}) — cannot derive an apply root." >&2
    return 1
  fi
  case "${first_abs}" in
    "${dsh_root}"/lib/*) apply_root="${dsh_root}" ;;
    "${dsh_root}"/node_modules/*) apply_root="${dsh_root}/$(echo "${first_abs}" | sed -e "s|^${dsh_root}/||" | cut -d/ -f1-3)" ;;
    *) echo "FAIL: cannot derive apply root for ${first_abs}" >&2; return 1 ;;
  esac
  # RESOLVE the real apply root: the real dir that CONTAINS the package's real
  # lib/ dir (patch paths are lib/... relative to it). Even when lib/ (or the
  # dsh root's lib/) is a symlink to an outer store, the applied files land
  # INSIDE this real root — the containment GNU patch requires.
  local real_lib real_root
  real_lib="$(readlink -f "${apply_root}/lib" 2>/dev/null || true)"
  if [[ -z "${real_lib}" || ! -d "${real_lib}" ]]; then
    echo "FAIL: cannot resolve the real lib dir of ${apply_root} (missing or dangling symlink?) — refusing to patch." >&2
    return 1
  fi
  real_root="$(dirname "${real_lib}")"
  local patch_file="${PATCH_DIR}/${patch}" chosen_patch="${patch}" one_state=""
  local need_direct=0 need_plain=0 unknown=0
  local all_applied=1
  local t_abs t_real t_rel
  for f in "${files[@]}"; do
    IFS='|' read -r t_abs t_real t_rel cur_patch pristine applied direct <<< "${f}"
    # Clear errors for missing / dangling / inconsistent staging — never
    # patch's raw ENOTDIR "can't find file to patch".
    if [[ -z "${t_real}" || ! -f "${t_real}" ]]; then
      echo "FAIL: target not found or dangling symlink for ${t_rel} (${t_abs})" >&2
      return 1
    fi
    if [[ "${t_real}" != "${real_lib}"/* ]]; then
      echo "FAIL: ${t_rel} resolves OUTSIDE the group's real lib dir (${real_lib}) — inconsistent staging (real: ${t_real})." >&2
      return 1
    fi
    local md5 state others
    md5="$(md5_of "${t_real}")"
    others="$(chain_others "${t_abs:-cli:${t_rel}}" "${pristine}" "${applied}" "${direct}")"
    state="$(classify_chain "${md5}" "${pristine}" "${applied}" "${direct}" "${others}" || echo UNKNOWN)"
    # APPLIED and PRECEDING are both covered elsewhere in the chain: APPLIED is
    # this patch's goal state; PRECEDING is an EARLIER row's base (that group
    # applies first in an apply_chain run, so the copy reaches my base before
    # this group's turn — defensively skipping here avoids a wrong-patch apply).
    if [[ "${state}" == "APPLIED" || "${state}" == "PRECEDING" ]]; then continue; fi
    all_applied=0
    case "${state}" in
      PRISTINE)    need_plain=1 ;;
      DIRECT_EDIT) need_direct=1 ;;
      *) unknown=1; echo "FAIL: ${t_rel} drifted (md5 ${md5}) — refusing to force-apply." >&2; return 1 ;;
    esac
  done
  [[ "${all_applied}" -eq 1 ]] && { echo "SKIP:  ${patch} already fully applied (idempotent)."; return 0; }
  if [[ "${need_direct}" -eq 1 ]]; then
    chosen_patch="${NORM_PATCH}"
    if [[ "${need_plain}" -eq 1 ]]; then
      echo "FAIL: ${patch} covers mixed pristine/direct-edit states in one group — normalize the direct-edit files first (apply the normalization patch separately)." >&2
      return 1
    fi
  fi
  patch_file="${PATCH_DIR}/${chosen_patch}"
  [[ -f "${patch_file}" ]] || { echo "FAIL: patch file missing: ${patch_file}" >&2; return 1; }
  # backup every covered target (REAL paths), apply once, verify each, restore all on failure.
  mkdir -p "${BACKUP_DIR}"
  local backups=()
  for f in "${files[@]}"; do
    IFS='|' read -r t_abs t_real t_rel cur_patch pristine applied direct <<< "${f}"
    local backup="${BACKUP_DIR}/$(basename "${t_real}")-pre-${stamp}-a-harness"
    cp -p "${t_real}" "${backup}"
    backups+=("${backup}|${t_real}")
    echo "Backup written: ${backup}"
  done
  if ! patch -p1 -d "${real_root}" -f -N < "${patch_file}"; then
    echo "FAIL: patch application failed for ${patch} — restoring backups." >&2
    for b in "${backups[@]}"; do IFS='|' read -r bk treal <<< "${b}"; cp -p "${bk}" "${treal}"; done
    return 1
  fi
  local ok=1
  for f in "${files[@]}"; do
    IFS='|' read -r t_abs t_real t_rel cur_patch pristine applied direct <<< "${f}"
    local new_md5
    new_md5="$(md5_of "${t_real}")"
    if [[ "${new_md5}" != "${applied}" ]]; then
      echo "FAIL: post-apply verification of ${t_rel} failed (md5 ${new_md5}, expected ${applied})." >&2
      ok=0
    else
      echo "PASS: ${t_rel} updated to the applied fingerprint (${new_md5})."
    fi
  done
  if [[ "${ok}" -eq 0 ]]; then
    for b in "${backups[@]}"; do IFS='|' read -r bk treal <<< "${b}"; cp -p "${bk}" "${treal}"; done
    echo "FAIL: verification failed — backups restored." >&2
    return 1
  fi
  return 0
}

apply_chain() {
  local dsh_root="$1" stamp
  stamp="$(date +%Y%m%d-%H%M)"
  local patches=()
  while IFS='|' read -r abs real relpath patch pristine applied direct; do
    [[ " ${patches[*]} " == *" ${patch} "* ]] || patches+=("${patch}")
  done < <(resolve_targets "${dsh_root}")
  for p in "${patches[@]}"; do apply_group "${dsh_root}" "${p}" "${stamp}" || return 1; done
  echo "A-HARNESS apply complete (no restart performed by this script)."
}

cmd=""
allow_stable=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|check) cmd="check" ;;
    apply) cmd="apply" ;;
    --detect) cmd="detect" ;;
    --allow-stable) allow_stable=1 ;;
    -h|--help)
      sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "${cmd}" ]] && { echo "usage: $0 --check|apply|--detect [--allow-stable]" >&2; exit 2; }

if ! dsh_root="$(detect_dsh_root)"; then
  echo "FAIL: could not detect the installed dsh root (dsh CLI not found)." >&2
  exit 1
fi
echo "dsh root: ${dsh_root}"

if [[ "${cmd}" == "detect" ]]; then
  while IFS='|' read -r abs real relpath patch pristine applied direct; do
    if [[ -z "${real}" ]]; then
      echo "${relpath} -> ${abs:-<not found>} (UNRESOLVABLE: missing or dangling symlink)"
    elif [[ "${real}" != "${abs}" ]]; then
      echo "${relpath} -> ${abs} (real: ${real})"
    else
      echo "${relpath} -> ${abs}"
    fi
  done < <(resolve_targets "${dsh_root}")
  exit 0
fi

if [[ "${allow_stable}" -ne 1 ]]; then
  case "${dsh_root}" in
    "${STABLE_HOME}"/*)
      echo "FAIL: the detected dsh root is under the stable instance home (${STABLE_HOME}) — refusing per policy. Pass --allow-stable to override deliberately." >&2
      exit 1;;
  esac
fi

case "${cmd}" in
  check) check_chain "${dsh_root}" ;;
  apply) apply_chain "${dsh_root}" ;;
esac