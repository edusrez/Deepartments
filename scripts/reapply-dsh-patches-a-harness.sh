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
#   patches/dsh-tool-fs-search-fb51-direct-edit-normalize.patch  (ONE-TIME: live
#     direct-edit state -> compiled payload form; the durable patch is the
#     anchor-literal-glob one above, based on the reconstructed pristine)
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
  "node_modules/@deepseek-ai/dsh-tool-fs-search lib/types/glob.d.ts dsh-tool-fs-search-anchor-literal-glob.patch abb3e1903c42e878cb7bc76cece2ad90 ac12dc59628e934777f224164c5459fd 5d10ebee03e200ad16929e0291206efa"
  "node_modules/@deepseek-ai/dsh-app-boot lib/index.js dsh-app-boot-watch-patch-layers.patch f89b0aa41c566589162295578ebb8749 a4f6123a217ac6f4e4cc7280a0d547dc"
  "node_modules/@deepseek-ai/dsh-app-boot lib/types/index.d.ts dsh-app-boot-watch-patch-layers.patch 5ed502c91a525f05367730f28b10e160 027fdc1cc3b47982027997f7902e2150"
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

# resolve each chain entry: prints "abs|relpath|patch|pristine|applied|direct"
resolve_targets() {
  local dsh_root="$1" chunk
  chunk="$(detect_profile_boot_chunk "${dsh_root}" || true)"
  while IFS=' ' read -r pkgroot relpath patch pristine applied direct; do
    local abs
    if [[ "${relpath}" == "CLI_CHUNK" ]]; then
      if [[ -n "${chunk}" ]]; then abs="${chunk}"; relpath="${chunk#${dsh_root}/}"; else abs=""; relpath="lib/profile-boot-<chunk-missing>.js"; fi
    else
      abs="${dsh_root}/${pkgroot}/${relpath}"
    fi
    echo "${abs}|${relpath}|${patch}|${pristine}|${applied}|${direct:-}"
  done <<< "$(printf '%s\n' "${A_HARNESS[@]}")"
}

check_chain() {
  local dsh_root="$1" saw_applied=0 saw_pristine=0 saw_direct=0 saw_unknown=0
  echo "A-HARNESS chain over: ${dsh_root}"
  while IFS='|' read -r abs relpath patch pristine applied direct; do
    local state md5
    if [[ -z "${abs}" || ! -f "${abs}" ]]; then
      echo "  FAIL:  target not found for ${relpath}" >&2
      return 1
    fi
    md5="$(md5_of "${abs}")"
    state="$(classify "${md5}" "${pristine}" "${applied}" "${direct}" || echo UNKNOWN)"
    case "${state}" in
      APPLIED)    saw_applied=1; echo "  PASS:   ${relpath} is patched (${md5})";;
      PRISTINE)   saw_pristine=1; echo "  NOT:    ${relpath} is pristine rc.2 (${md5})";;
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
apply_group() {
  local dsh_root="$1" patch="$2" stamp="$3" pkgroot="" abs relpath pristine applied direct apply_root
  local files=() any=0
  while IFS='|' read -r abs relpath cur_patch pristine applied direct; do
    [[ "${cur_patch}" == "${patch}" ]] || continue
    files+=("${abs}|${relpath}|${cur_patch}|${pristine}|${applied}|${direct:-}")
  done < <(resolve_targets "${dsh_root}")
  [[ "${#files[@]}" -eq 0 ]] && return 0
  # The apply root is the owning package dir: <dsh-root> for the CLI's own
  # lib/* files, <dsh-root>/node_modules/@deepseek-ai/<pkg> for nested files.
  local first_rel first_abs
  IFS='|' read -r first_abs first_rel cur_patch pristine applied direct <<< "${files[0]}"
  local apply_root
  # Derive from the ABSOLUTE path (the record's relpath is file-only): files
  # under <dsh-root>/lib/* belong to the CLI package (root = the dsh root);
  # files under <dsh-root>/node_modules/@deepseek-ai/<pkg>/* belong to that
  # package (root = the first three path segments after the dsh root).
  case "${first_abs}" in
    "${dsh_root}"/lib/*) apply_root="${dsh_root}" ;;
    "${dsh_root}"/node_modules/*) apply_root="${dsh_root}/$(echo "${first_abs}" | sed -e "s|^${dsh_root}/||" | cut -d/ -f1-3)" ;;
    *) echo "FAIL: cannot derive apply root for ${first_abs}" >&2; return 1 ;;
  esac
  local patch_file="${PATCH_DIR}/${patch}" chosen_patch="${patch}" one_state=""
  local need_direct=0 need_plain=0 unknown=0
  local all_applied=1
  for f in "${files[@]}"; do
    IFS='|' read -r abs relpath cur_patch pristine applied direct <<< "${f}"
    local md5 state
    md5="$(md5_of "${abs}")"
    state="$(classify "${md5}" "${pristine}" "${applied}" "${direct}" || echo UNKNOWN)"
    if [[ "${state}" == "APPLIED" ]]; then continue; fi
    all_applied=0
    case "${state}" in
      PRISTINE)    need_plain=1 ;;
      DIRECT_EDIT) need_direct=1 ;;
      *) unknown=1; echo "FAIL: ${relpath} drifted (md5 ${md5}) — refusing to force-apply." >&2; return 1 ;;
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
  # backup every covered target, apply once, verify each, restore all on failure.
  mkdir -p "${BACKUP_DIR}"
  local backups=()
  for f in "${files[@]}"; do
    IFS='|' read -r abs relpath cur_patch pristine applied direct <<< "${f}"
    local backup="${BACKUP_DIR}/$(basename "${abs}")-pre-${stamp}-a-harness"
    cp -p "${abs}" "${backup}"
    backups+=("${backup}|${abs}")
    echo "Backup written: ${backup}"
  done
  if ! patch -p1 -d "${apply_root}" -f -N < "${patch_file}"; then
    echo "FAIL: patch application failed for ${patch} — restoring backups." >&2
    for b in "${backups[@]}"; do IFS='|' read -r bk abs <<< "${b}"; cp -p "${bk}" "${abs}"; done
    return 1
  fi
  local ok=1
  for f in "${files[@]}"; do
    IFS='|' read -r abs relpath cur_patch pristine applied direct <<< "${f}"
    local new_md5
    new_md5="$(md5_of "${abs}")"
    if [[ "${new_md5}" != "${applied}" ]]; then
      echo "FAIL: post-apply verification of ${relpath} failed (md5 ${new_md5}, expected ${applied})." >&2
      ok=0
    else
      echo "PASS: ${relpath} updated to the applied fingerprint (${new_md5})."
    fi
  done
  if [[ "${ok}" -eq 0 ]]; then
    for b in "${backups[@]}"; do IFS='|' read -r bk abs <<< "${b}"; cp -p "${bk}" "${abs}"; done
    echo "FAIL: verification failed — backups restored." >&2
    return 1
  fi
  return 0
}

apply_chain() {
  local dsh_root="$1" stamp
  stamp="$(date +%Y%m%d-%H%M)"
  local patches=()
  while IFS='|' read -r abs relpath patch pristine applied direct; do
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
  while IFS='|' read -r abs relpath patch pristine applied direct; do
    echo "${relpath} -> ${abs:-<not found>}"
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