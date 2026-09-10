#!/usr/bin/env bash
#
# reapply-deepartments-patches.sh - re-apply the Deepartments maintenance patches
# to the installed dsh / pi-ai tree after a dsh upgrade.
#
# These patches live OUTSIDE the repo, inside the global npm install, and are
# LOST on every `dsh` upgrade. The manifest (patches/deepartments-maintenance.tsv)
# lists each patch with its package root and both md5 fingerprints, so this
# script is generic: adding a patch is a manifest line plus a .patch file.
#
# Usage:
#   scripts/reapply-deepartments-patches.sh --check     report status of every patch
#   scripts/reapply-deepartments-patches.sh apply       apply the ones not yet applied
#   scripts/reapply-deepartments-patches.sh --list      list the manifest
#
# Status vocabulary (per patch):
#   PATCHED   md5 == md5-patched               (nothing to do)
#   PRISTINE  md5 == md5-pristine              (apply will patch it)
#   FAIL      md5 matches neither fingerprint  (upstream drifted: port by hand)
#
# `apply` refuses any patch whose target is neither pristine nor patched, backs
# the target up to /opt/dsh/backups/ BEFORE patching, verifies the resulting md5
# against md5-patched, and RESTORES the backup if it does not match. It is
# idempotent. Restart the dsh service afterwards for the patches to take effect.
#
# The patches themselves:
#   session-list-parallel   - makes JsonlSessionPersistence.listArtifacts() probe
#                             session directories with bounded concurrency instead
#                             of one at a time. Sequential probing cost ~4-8 fs
#                             round trips PER SESSION: with 2,420 sessions the
#                             listing alone measured 2,870 ms and dominated the
#                             "several seconds to open a conversation" symptom.
#                             Verified to return an identical id list in an
#                             identical order; 3.6x faster warm (2,870 -> 794 ms).
#   pi-ai-dead-partial-parse - removes the per-SSE-delta `parseStreamingJson` in
#                             the openai-completions adapter. That call's result
#                             was DEAD WORK: `block.arguments` is read only by
#                             finishBlock() (the authoritative parse of the
#                             complete buffer) and by getCustomToolCallInput()
#                             (which reads what appendCustomToolCallInput sets).
#                             The only consumer of the streaming event emits
#                             `argumentsDelta: event.delta` (raw text) and reads
#                             `event.partial` solely for the block id/name.
#                             Re-parsing the whole accumulated buffer per delta is
#                             O(n^2): measured over 1,399 real tool calls, 795,109
#                             deltas (up to 11,055 in ONE call) scanned 3,116 MB to
#                             produce 2.54 MB of arguments - 1,228x amplification.
#                             Verified: accumulating and parsing once reproduces the
#                             recorded final arguments in 375/375 comparable real
#                             tool calls.
#
set -euo pipefail

BACKUP_DIR="/opt/dsh/backups"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_DIR="${REPO_ROOT}/patches"
MANIFEST="${PATCH_DIR}/deepartments-maintenance.tsv"

usage() { sed -n '3,58p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

[[ -f "${MANIFEST}" ]] || { echo "FAIL: manifest missing: ${MANIFEST}" >&2; exit 1; }

md5_of() { md5sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Test seam (mirrors the repo's a-harness pattern): prefix every package root so
# the whole flow can be exercised against a throwaway copy of the tree.
PREFIX="${DSH_PATCH_ROOT_PREFIX:-}"

# Emit the manifest rows as: name|target|pristine|patched|patchfile
rows() { grep -v '^[[:space:]]*#' "${MANIFEST}" | grep -v '^[[:space:]]*$'; }

MODE="${1:---check}"
case "${MODE}" in -h|--help) usage; exit 0 ;; esac

if [[ "${MODE}" == "--list" ]]; then
  printf '%-24s %-10s %s\n' "NAME" "STATUS" "TARGET"
  while IFS=$'\t' read -r name rel pkgroot pristine patched pf; do
    target="${PREFIX}${pkgroot}/${rel}"
    cur="$(md5_of "${target}")"
    st="FAIL"
    [[ "${cur}" == "${patched}" ]] && st="PATCHED"
    [[ "${cur}" == "${pristine}" ]] && st="PRISTINE"
    [[ -z "${cur}" ]] && st="MISSING"
    printf '%-24s %-10s %s\n' "${name}" "${st}" "${target}"
  done < <(rows)
  exit 0
fi

[[ "${MODE}" == "--check" || "${MODE}" == "apply" ]] || { usage; exit 1; }

overall=0
while IFS=$'\t' read -r name rel pkgroot pristine patched pf; do
  target="${PREFIX}${pkgroot}/${rel}"
  patchfile="${PATCH_DIR}/${pf}"
  cur="$(md5_of "${target}")"

  if [[ -z "${cur}" ]]; then
    echo "FAIL     ${name}: target not found: ${target}"; overall=1; continue
  fi

  if [[ "${cur}" == "${patched}" ]]; then
    echo "PATCHED  ${name}"; continue
  fi

  if [[ "${cur}" != "${pristine}" ]]; then
    echo "FAIL     ${name}: md5 ${cur} matches no fingerprint (upstream drifted) — port by hand"; overall=1; continue
  fi

  # pristine from here on
  if [[ "${MODE}" == "--check" ]]; then
    echo "PRISTINE ${name} — run: $0 apply"; continue
  fi

  [[ -f "${patchfile}" ]] || { echo "FAIL     ${name}: patch file missing: ${patchfile}" >&2; overall=1; continue; }

  mkdir -p "${BACKUP_DIR}"
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="${BACKUP_DIR}/$(basename "${rel}")-pre-${stamp}-${name}"
  cp -a "${target}" "${backup}"

  if ! patch -p1 -d "${PREFIX}${pkgroot}" < "${patchfile}" >/dev/null 2>&1; then
    cp -a "${backup}" "${target}"
    echo "FAIL     ${name}: patch did not apply; target restored from backup" >&2; overall=1; continue
  fi

  new="$(md5_of "${target}")"
  if [[ "${new}" != "${patched}" ]]; then
    cp -a "${backup}" "${target}"
    echo "FAIL     ${name}: post-patch md5 ${new} != expected ${patched}; target restored" >&2; overall=1; continue
  fi

  echo "APPLIED  ${name}  (backup: ${backup})"
done < <(rows)

if [[ "${MODE}" == "apply" && "${overall}" -eq 0 ]]; then
  echo
  echo "Restart dsh for the patches to take effect:  systemctl restart dsh-deepartments-dev.service"
fi
exit "${overall}"
