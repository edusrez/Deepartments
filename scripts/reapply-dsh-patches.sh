#!/usr/bin/env bash
#
# reapply-dsh-patches.sh - re-apply dsh-deepartments maintenance patches to the
# installed dsh tree after a dsh upgrade (patches that live outside the repo,
# inside the global npm install, and are lost on every `dsh` upgrade).
#
# Managed patches (see patches/README.md), applied as a STAGED chain:
#   stage 1: dsh-llm-deepseek-orphan-sweep.patch  - orphan role:'tool' sweep
#     (Fix B) in @deepseek-ai/dsh-llm-deepseek/lib/index.js (pristine -> da90e47f)
#   stage 2: dsh-llm-deepseek-toolcall-strip.patch - tool-call consecutiveness
#     strip in BOTH serializers (stage-1 da90e47f -> 3390675e)
#
# Usage:
#   scripts/reapply-dsh-patches.sh --check [TARGET_FILE]
#       PASS (exit 0)            target is fully patched (stages 1+2, stage-2 md5)
#       PARTIAL (exit 0)         only stage 1 (orphan sweep) applied - stage 2
#                                (tool-call strip) missing; run: ... apply
#       NOT APPLIED (exit 0)     target is pristine 0.1.1-rc.2 (pristine md5)
#       FAIL (exit 1)            target md5 matches no fingerprint -> upstream
#                                drifted, manual port needed (see patches/README.md)
#   scripts/reapply-dsh-patches.sh apply [TARGET_FILE]
#       Refuses if fully patched (idempotent, exit 0). Fingerprint gates:
#       pristine -> stage 1 -> stage 2 (chained, each verified); stage-1-only
#       -> stage 2. Each stage backs up the target to
#       /opt/dsh/backups/llm-deepseek-index.js-pre-<date>-<time>-<stage> before
#       applying and verifies the result md5 (restores the backup on failure).
#   --allow-stable: allow an explicit TARGET_FILE under /opt/dsh/.dsh (the
#       stable instance home). Default: paths under the stable home are refused,
#       and auto-detection never points at the stable tree.
#
# Default TARGET_FILE: the dsh-llm-deepseek lib index.js of the active dsh
# install (auto-detected from the dsh CLI / global npm root). In this
# deployment dev (DSH_HOME=/opt/dsh/.dsh-dev) and stable (DSH_HOME=/opt/dsh/.dsh)
# share that single global CLI, so there is exactly one file to patch.
#
set -euo pipefail

# ---- fingerprints (md5) -----------------------------------------------------
# Pristine @deepseek-ai/dsh 0.1.1-rc.2 lib/index.js (78 334 B) - the ONLY
# baseline the chain is allowed to modify.
MD5_PRISTINE_RC2="f82d2ea38a6a27ae0c7f691d384b3949"
# Same file with the stage-1 orphan sweep applied (78 712 B) - stage-2 base.
MD5_STAGE1="da90e47fccdeae16f93472159aee0e1c"
# Same file with stages 1+2 applied (tool-call strip) - the only accepted end state.
MD5_STAGE2="3390675e5d48a82fe906ba365d91713f"

BACKUP_DIR="/opt/dsh/backups"
STABLE_HOME="/opt/dsh/.dsh"          # stable instance state home - off-limits by default

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_STAGE1="${REPO_ROOT}/patches/dsh-llm-deepseek-orphan-sweep.patch"
PATCH_STAGE2="${REPO_ROOT}/patches/dsh-llm-deepseek-toolcall-strip.patch"

usage() {
  sed -n '3,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---- auto-detect the installed dsh-llm-deepseek lib/index.js ----------------
detect_target() {
  local candidates=() c cli_bin resolved bin_dir npm_g
  cli_bin="$(command -v dsh 2>/dev/null || true)"
  if [[ -n "${cli_bin}" ]]; then
    resolved="$(readlink -f "${cli_bin}" 2>/dev/null || true)"
    if [[ -n "${resolved}" ]]; then
      bin_dir="$(dirname "${resolved}")"          # <root>/@deepseek-ai/dsh/lib
      candidates+=("$(cd "${bin_dir}/.." 2>/dev/null && pwd)/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js")
    fi
  fi
  npm_g="$(npm root -g 2>/dev/null || true)"
  if [[ -n "${npm_g}" ]]; then
    candidates+=("${npm_g}/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js")
  fi
  if [[ -n "${DSH_LLM_DEEPSEEK_INDEX:-}" ]]; then
    candidates+=("${DSH_LLM_DEEPSEEK_INDEX}")
  fi
  for c in "${candidates[@]}"; do
    if [[ -n "${c}" && -f "${c}" ]]; then
      echo "${c}"
      return 0
    fi
  done
  return 1
}

md5_of() { md5sum "$1" | awk '{print $1}'; }

check_file() {
  local f="$1" md5
  [[ -f "${f}" ]] || { echo "FAIL: target file not found: ${f}" >&2; return 1; }
  md5="$(md5_of "${f}")"
  if [[ "${md5}" == "${MD5_STAGE2}" ]]; then
    echo "PASS: ${f} is fully patched (stages 1+2 applied; md5 ${md5} matches the stage-2 fingerprint)."
    return 0
  elif [[ "${md5}" == "${MD5_STAGE1}" ]]; then
    echo "PARTIAL: ${f} has stage 1 (orphan sweep) but NOT stage 2 (tool-call strip) (md5 ${md5}). Run: $(basename "$0") apply"
    return 0
  elif [[ "${md5}" == "${MD5_PRISTINE_RC2}" ]]; then
    echo "NOT APPLIED: ${f} is pristine 0.1.1-rc.2 (md5 ${md5} matches the pristine fingerprint). Run: $(basename "$0") apply"
    return 0
  else
    echo "FAIL: upstream drifted - manual port needed (md5 ${md5} matches neither the pristine rc.2 nor the stage-1/stage-2 fingerprints). See patches/README.md for the manual-port procedure." >&2
    return 1
  fi
}

# Apply one stage: backup, fingerprint-gate, patch, verify, restore on failure.
# $1 target file  $2 patch file  $3 expected md5 after the stage  $4 stage label
apply_stage() {
  local f="$1" patch_file="$2" expected="$3" label="$4" md5 stamp backup new_md5
  [[ -f "${f}" ]] || { echo "FAIL: target file not found: ${f}" >&2; return 1; }
  [[ -f "${patch_file}" ]] || { echo "FAIL: patch file missing: ${patch_file}" >&2; return 1; }
  md5="$(md5_of "${f}")"
  if [[ "${md5}" == "${expected}" ]]; then
    echo "SKIP: ${f} already has ${label} - nothing to do (idempotent)."
    return 0
  fi
  mkdir -p "${BACKUP_DIR}"
  stamp="$(date +%Y%m%d-%H%M)"
  backup="${BACKUP_DIR}/llm-deepseek-index.js-pre-${stamp}-${label}"
  cp -p "${f}" "${backup}"
  echo "Backup written: ${backup}"
  # GNU patch refuses absolute target paths ("potentially dangerous file
  # name"), so rewrite the self-contained diff headers to the plain basename
  # and apply with -p0 from the target's directory (relative name, safe).
  # Comment lines above the diff are ignored by GNU patch.
  local base
  base="$(basename "${f}")"
  if ! sed -e "s|^--- a/.*|--- ${base}|" -e "s|^+++ b/.*|+++ ${base}|" "${patch_file}" | (cd "$(dirname "${f}")" && patch -p0 -f -N); then
    echo "FAIL: ${label} patch application failed - restoring ${backup}." >&2
    cp -p "${backup}" "${f}"
    return 1
  fi
  new_md5="$(md5_of "${f}")"
  if [[ "${new_md5}" != "${expected}" ]]; then
    echo "FAIL: post-apply verification of ${label} failed (md5 ${new_md5}, expected ${expected}) - restoring ${backup}." >&2
    cp -p "${backup}" "${f}"
    return 1
  fi
  echo "PASS: ${label} applied to ${f} and verified (md5 ${new_md5} matches the ${label} fingerprint)."
}

apply_file() {
  local f="$1" md5
  [[ -f "${f}" ]] || { echo "FAIL: target file not found: ${f}" >&2; return 1; }
  md5="$(md5_of "${f}")"
  if [[ "${md5}" == "${MD5_STAGE2}" ]]; then
    echo "SKIP: ${f} is already fully patched (stages 1+2) - nothing to do (idempotent)."
    return 0
  fi
  if [[ "${md5}" == "${MD5_STAGE1}" ]]; then
    apply_stage "${f}" "${PATCH_STAGE2}" "${MD5_STAGE2}" "stage-2"
    return $?
  fi
  if [[ "${md5}" == "${MD5_PRISTINE_RC2}" ]]; then
    apply_stage "${f}" "${PATCH_STAGE1}" "${MD5_STAGE1}" "stage-1" || return $?
    apply_stage "${f}" "${PATCH_STAGE2}" "${MD5_STAGE2}" "stage-2"
    return $?
  fi
  echo "FAIL: fingerprint gate rejected - upstream drifted - manual port needed (md5 ${md5}, expected pristine ${MD5_PRISTINE_RC2} or stage-1 ${MD5_STAGE1}). See patches/README.md." >&2
  return 1
}

# ---- argument parsing --------------------------------------------------------
cmd=""
target=""
allow_stable=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)       cmd="check" ;;
    apply)         cmd="apply" ;;
    --allow-stable) allow_stable=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)
      if [[ -n "${target}" ]]; then usage; exit 2; fi
      target="$1"
      ;;
  esac
  shift
done

if [[ -z "${cmd}" ]]; then
  usage
  exit 2
fi

if [[ -z "${target}" ]]; then
  if ! target="$(detect_target)"; then
    echo "FAIL: could not auto-detect the installed dsh-llm-deepseek lib/index.js (dsh CLI not found / npm root -g unavailable). Pass the target file explicitly." >&2
    exit 1
  fi
  echo "Target (auto-detected): ${target}"
else
  # Stable-protection: an explicit target under the stable instance home needs --allow-stable.
  case "${target}" in
    "${STABLE_HOME}"/*)
      if [[ "${allow_stable}" -ne 1 ]]; then
        echo "FAIL: '${target}' is under the stable instance home (${STABLE_HOME}) - refusing per policy. Pass --allow-stable to override deliberately." >&2
        exit 1
      fi
      ;;
  esac
  echo "Target (explicit): ${target}"
fi

case "${cmd}" in
  check) check_file "${target}" ;;
  apply) apply_file "${target}" ;;
esac