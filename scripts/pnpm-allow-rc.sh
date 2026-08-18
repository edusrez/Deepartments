#!/usr/bin/env bash
# pnpm-allow-rc.sh
#
# Local convenience helper for the Deepartments repo.
#
# pnpm 11 enforces a ~24h release-age policy: freshly-published
# "@deepseek-ai/*@0.1.0-rc.X" pinned in package.json make `pnpm install` /
# `pnpm build` fail unless a local pnpm-workspace.yaml carries a
# minimumReleaseAgeExclude list. This script (re)generates that local file
# from the resolved dependency graph (package.json + pnpm-lock.yaml),
# mirroring the exact format pnpm auto-writes.
#
# The generated pnpm-workspace.yaml is a LOCAL convenience: it is gitignored
# and never committed (the general public keeps the 24h policy). See
# .gitignore.
set -euo pipefail

# Resolve the repo root as the script dir's parent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
YAML_FILE="${REPO_ROOT}/pnpm-workspace.yaml"

# Safety guard: never clobber a committed config. If the file is tracked by
# git, bail out before writing anything.
if git -C "${REPO_ROOT}" ls-files --error-unmatch pnpm-workspace.yaml >/dev/null 2>&1; then
  echo "error: pnpm-workspace.yaml is tracked by git; refusing to overwrite a committed config." >&2
  echo "remove it from version control (e.g. 'git rm --cached pnpm-workspace.yaml') and retry." >&2
  exit 1
fi

# Collect every rc-pinned @deepseek-ai entry in the resolved dependency graph.
#
# Two sources, deduplicated on name@version:
#   1. package.json devDependencies + peerDependencies — keys starting with
#      "@deepseek-ai/" whose version string matches the rc form (e.g.
#      ^0.1.0-rc.7, 0.1.0-rc.7). A leading ^/~ /= is stripped; keys without
#      an rc (e.g. @deepseek-ai/cordis ^4.0.1) are skipped.
#   2. pnpm-lock.yaml — every rc-pinned "@deepseek-ai/*@0.1.0-rc.X" resolved
#      in the graph. This covers the transitive platform packages (dsh-agent,
#      dsh-attachment, dsh-brand, ...) pulled in by our direct rc deps, which
#      pnpm's release-age policy flags on lockfile verification. Without them
#      `pnpm build` fails, so the local exclusion file must list the full set
#      of freshly-published packages in the graph.
EXCLUDES="$(
  node -e '
    const fs = require("fs");
    const seen = new Set();
    // Source 1: direct rc pins from package.json.
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const section of ["devDependencies", "peerDependencies"]) {
      for (const [key, version] of Object.entries(pkg[section] || {})) {
        if (!key.startsWith("@deepseek-ai/")) continue;
        const match = /^[\^~=]?(0\.1\.0-rc\.\d+)$/.exec(String(version));
        if (!match) continue; // not an rc pin, e.g. cordis ^4.0.1
        seen.add(key + "@" + match[1]);
      }
    }
    // Source 2: rc-pinned @deepseek-ai packages resolved in the lockfile
    // (includes the transitive platform deps).
    if (fs.existsSync("pnpm-lock.yaml")) {
      const lock = fs.readFileSync("pnpm-lock.yaml", "utf8");
      const re = /@deepseek-ai\/([a-z0-9-]+)@(0\.1\.0-rc\.\d+)/g;
      let m;
      while ((m = re.exec(lock))) {
        seen.add("@deepseek-ai/" + m[1] + "@" + m[2]);
      }
    }
    const sorted = [...seen].sort();
    process.stdout.write(sorted.join("\n") + (sorted.length ? "\n" : ""));
  '
  # run in the repo root (node resolves ./package.json and ./pnpm-lock.yaml there)
  cd "${REPO_ROOT}"
)"

if [ -z "${EXCLUDES}" ]; then
  echo "no pinned rc found"
  exit 0
fi

# Emit pnpm-workspace.yaml in pnpm's own format: header, then 2-space-dash
# indented single-quoted "name@version" lines, alphabetical.
{
  echo "minimumReleaseAgeExclude:"
  while IFS= read -r entry; do
    printf "  - '%s'\n" "${entry}"
  done <<< "${EXCLUDES}"
} > "${YAML_FILE}"

COUNT="$(wc -l <<< "${EXCLUDES}")"
echo "excluded ${COUNT} rc-pinned package(s): wrote ${YAML_FILE}"
