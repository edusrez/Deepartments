# AGENTS.md — Deepartments repo working agreement

## Language policy (binding)

All repository content, code, comments, commit messages, reports and
documentation are written in **English**. Spanish is reserved exclusively for
direct owner communication (chat). Any file written in another language must
be translated.

Supplemental i18n translations are exempt from the English-only rule:
`README.zh.md` (Chinese) is allowed and must mirror the canonical
`README.md` (English), kept in sync by the reviewer gate. Any file other
than this sanctioned i18n README pair written in another language must
still be translated.

## What this repo is

The repo **is** the `dsh-deepartments` bundle: an npm plugin package for
DeepSeek Harness (DSH) that provides an agentic organization layer
(departments, posts that sleep and wake, witnesses, activations,
governance). DSH answers *how things run*; Deepartments answers *how things
are organized*. Context: [docs/IDEA.md](docs/IDEA.md) (the idea),
[docs/concept.md](docs/concept.md) (decisions and mapping),
[docs/ROADMAP.md](docs/ROADMAP.md) (phases and kickoff).

## Structure

- `package.json` — name `dsh-deepartments`, version `0.1.0` (first stable,
  released 2026-08-29; the 8 `packages/dshd-*` remain `0.1.0-rc.1`, their
  inter-peer graph `^0.1.0-rc.1` internally consistent), `type: module`,
  `main: lib/index.js`, `dsh.bundle` (patch → `cordis.patch.yml`),
  `peerDependencies` on the rc channel (`^0.1.0-rc.x`; a `^0.0.1` does not
  match rc).
- `cordis.patch.yml` — the configuration layer: top-level YAML array of
  patch entries; the row references the package by name (`name:
  dsh-deepartments`).
- `src/` → `lib/` — the Cordis plugin; compiled with **tsc NodeNext** to
  `lib/`.
- `docs/` — IDEA, concept, ROADMAP (project memory).
- `.dsh/skills/` — internal authorship skills (discovery root
  `<project>/.dsh/skills`, rank 100): `dsh-plugin-dev` for writing the
  plugin; `deepartments-workflow` (the conversational-orchestrator workflow,
  incl. the "Wake routine (injected wake)") — canonical copy is
  repo-tracked here at `.dsh/skills/deepartments-workflow/SKILL.md`, and the
  dev + stable agent presets symlink their skills dirs to this repo copy
  (legacy preset backups: `deepartments-workflow.bak-20260816/`).
- `packages/dshd-*` — the modular split (FASE 2.x): `dshd-core` (kernel) +
  `dshd-webfetch` are the original Cordis PLUGINs; P1 (2026-08-29) made the
  remaining **6** (`dshd-feedback`, `dshd-gui`, `dshd-health`, `dshd-jobs`,
  `dshd-pooler`, `dshd-quality`) real plugins TOO — each with its own
  `cordis.patch.yml` row (`dsh.bundle.patch` in its package.json) and a thin
  `name`/`inject`/`apply` surface providing a `deepartments.*` service
  (`feedback` store · `quality` emitter · `jobs` scheduler tick · `pooler`
  boot check · `health` daemon tick · `gui` channel dispatcher). DEP
  INJECTION CONVENTION (FASE 2.6): an apply NEVER imports bundle internals —
  it reads `ctx.get('deepartments.org')` (the shared config source) and
  `ctx.get('deepartments.binder')` (`register`/`get` buckets) at FIRST USE
  (lazy facades — an apply is side-effect free), and a required dep missing
  at use FAILS LOUD (R1). The bundle's own inline wiring for these 6 stays
  (R6, bridges untouched) until the DECOUPLING hito rewires it to the
  composed services.

## TIERED verification

1. `pnpm build` — tsc NodeNext compiles (src → lib), no type errors.
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` — installs the bundle in the development profile (isolated DSH_HOME `/opt/dsh/.dsh-dev`, never the default `/opt/dsh/.dsh` which is the stable instance).
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` — composes the tree WITHOUT booting; **must show the `# == dsh-deepartments` layer**.
4. Real headless smoke in the twin profile: `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev-headless "<prompt>"` (the GUI profile `deepartments-dev` rejects CLI prompt arguments).

**Tests (SRC-NATIVE method, fb-95)**: run the suite with PLAIN `node --test` over the BUILT `lib/` (`pnpm test`) — never `node --loader ./test/ts-src-loader.mjs --test` as a whole-suite default, which FALSE-FAILS the composition/Loader family even on a clean tree. The `ts-src-loader.mjs` hook is only for the lane-② src-native tests that SELF-REGISTER it (`register(new URL('./ts-src-loader.mjs', import.meta.url), …)`); built-lib tests load byte-identical either way. For the suite-integrity guard (fb-91) use `pnpm test:guarded`; full ladder reference (incl. review worktree isolation A4-2 + the fb-140 absolute-report-path convention): `docs/VERIFICATION-LADDER.md`.

Before restarting the service to verify a change: use the `smart_restart` tool (canary) — never a raw `systemctl restart`/`reboot` — because a raw restart with active subagents/workers kills their in-flight turn.

Development and smoke ALWAYS in `deepartments-dev` — **never against the web
profile in use**. Restart required after `add` (manifest and client metadata
are cached); user edits to `cordis.patch.yml` are HMR. All dsh commands for development MUST set `DSH_HOME=/opt/dsh/.dsh-dev` (isolated home: GUI profile `deepartments-dev` on port 3090, Tailscale 8445; headless twin `deepartments-dev-headless` for CLI smoke); the stable instance lives in `/opt/dsh/.dsh` (port 3080, Tailscale 8444).

## Non-negotiable rules

1. **No `export default`** (postmortem 0001 — breaks `inject`).
2. **`!!js` only inside `config`**, never in metadata fields
   (postmortem 0002).
3. **`defineTool` with `output.{schema,render}` mandatory**; `parameters`
   flat with `required: true`.
4. Every registration as a **reversible effect**; no global mutable state
   outside `apply`.
5. **Tests that go through the real Loader** (never only manual mount).
6. Development and smoke in the isolated DSH_HOME `/opt/dsh/.dsh-dev` (`deepartments-dev` GUI profile, port 3090; `deepartments-dev-headless` twin for CLI smoke). Never against the web profile in use.
7. Isolate renamable services: `ctx.get('webServer') ?? ctx.get('httpServer')`.
8. `peerDependencies` on the rc channel (`^0.1.0-rc.x`) and **CLI pin**:
   `npx -p @deepseek-ai/dsh@0.1.1-rc.2`.
9. **Never poll subagents.** After dispatching via `subagent`/`subagent_fork`
   (always-async, no blocking), END THE TURN. Do not run `sleep`,
   `list_agents`, `job_list`, `cat`/`grep` loops to check completion. The
   harness wakes you with a settlement notice; continue dependent work only
   when that notice arrives. One `send_message` per follow-up turn.
10. **Ownership & delegation.** The repo's internal programming and deep
   analysis belong to the Internal Programming Department (IPD) — route them
   with ONE `send_message` to `internal-programming-head`; the Asistente never
   deploys IPD workers itself, and never dispatches a transient subagent for
   IPD-owned work (the emergency fallback is defined by spec 005 / the
   deepartments-workflow skill — reference it, never rewrite it). The ACL
   applies ONLY to root agents (heads and workers): a transient subagent is NOT
   an ACL subject — never apply the worker ACL to a child, nor treat a worker
   root as a child.

Details and rationale for each rule: skill `dsh-plugin-dev`
(`.dsh/skills/dsh-plugin-dev/SKILL.md`).

## Environment variables

Runtime knobs read by the plugin (`src/invoke.ts`) — all OPTIONAL:

- `DEEPARTMENTS_QUALITY_INSPECT` — a numeric string in `[0,1]`; the **single
  documented override** of the quality-inspect dice probability (dec5): the
  worker-retire and QH-sleep dice (spec 007 §4.1/§5.2, D-Q2/D-Q7). When set and
  valid it wins over the `quality.workerInspectProbability` config value
  (priority: env > config > code default `0.25`); the structural NON-QH
  head/host 100% inspect mandate is never overridden (it is not a dice).
- `DEEPARTMENTS_TEST_NOW` — **test-only**: a fixed clock (epoch ms) for hermetic
  Loader tests (rule 5); unset → the real wall clock.
- `DEEPARTMENTS_DISPOSE_JOIN_TIMEOUT_MS` — the bounded detach-join window (ms)
  for the sleep respawn; default `10_000` (a normal join settles in
  milliseconds; the bound is a safety net — tests override it).
- `PARALLEL_API_KEY` — fallback API key for the parallel-monitor daemon when
  the `parallel` config section defines no `apiKey`.
- `DSH_HOME` — the harness home (`$DSH_HOME` if set, else `~/.dsh`);
  harness-level, not a Deepartments knob.

Note: `dept_exec` sanitizes the environment to `PATH`/`HOME`/`LANG` only — the
overrides above apply to the plugin daemon process, not to command tooling.

## Operations — session hygiene

`scripts/session-hygiene.mjs` is the reusable LOW vehicle (ROADMAP late-9 debt
"higiene sesiones muertas m-162") for the dec4 owner policy — "NO borrar,
COMPRIMIR": the full session history is always preserved, the cold tier is
compressed with zstd, nothing is ever destructively garbage-collected.

- **dec4 archive policy**: per session, the newest N rotation artifacts in the
  archive (default `--hot-rotations 3`) stay untouched ("hot"); every older
  artifact is compressed to `<file>.zstd` ("cold"), the uncompressed original
  being removed ONLY with `--apply`. One-way: nothing is ever decompressed.
- **Dead-session census** (report only, no deletes): a session dir whose last
  recorded turn is older than `--stale-days` (default 14) AND whose id is not
  referenced by a live (non-retired) `hosts.json`/`posts.json` entry.
- **`--tmp`**: reports (and with `--apply` sweeps) orphan `*.tmp` scratch
  files older than one boot cycle (`--tmp-stale-days`, default 1) in the state
  home's `storages` dir.
- **Safety**: DRY-RUN by default — `--apply` is the ONLY mutation switch;
  missing `zstd` → compression is reported but skipped (mtime fallback for log
  tails); `--apply` refuses to target the STABLE profile `/opt/dsh/.dsh`; dev
  home `/opt/dsh/.dsh-dev` is fine. Full usage/params live in the script header.
- **Directory resolution**: WITHOUT `--state-dir`, the stateDir resolves to
  `$DSH_HOME/.deepartments` (fallback `~/.dsh/.deepartments`) — the HARNESS
  home's Deepartments stateDir, which is NOT the dev deployment's relocated
  stateDir. The dev deployment ALWAYS needs the core dirs explicit (example
  below); the STABLE profile `/opt/dsh/.dsh` is excluded by the guard.
- **Bounded census** (a dry-run against a live state home must finish in
  seconds, not hang): the last-turn scan runs an in-process promise pool
  (`--scan-concurrency`, default 8, no worker threads), a per-file zstd tail
  timeout (`--tail-timeout-ms`, default 4000 — on expiry the session reports
  "unknown-last-turn (timeout)" and the mtime fallback covers), a candidate cap
  (`--scan-limit`, default 2000) and a global soft deadline (`--max-scan-ms`,
  default 30000) — truncation (limit or deadline) is always warned and
  reported, and progress lines go to stderr ("scanned i/N (k dead so far)",
  `--no-progress` silences them). Memory stays bounded to a 256 KiB tail
  window per log; the per-file timeout bounds the decompression time.

The dev deployment relocates the Deepartments stateDir, so pass the core dirs
explicitly there, e.g.:

```bash
node scripts/session-hygiene.mjs \
  --state-dir /.deepartments \
  --sessions-dir /opt/dsh/.dsh-dev/sessions \
  --tmp
```

## Session ritual

- **START** (injected wake, see "Wake routine"): the Deepartments wake pack is
  ALREADY in your initial context — identity, the pre-resolved journal path +
  body, the message delta TOC, condensed roster, git bearings, system state, and
  the full deepartments-workflow skill. Do not re-fetch any of it at wake. Call
  messaging tools only for LIVE needs the pack cannot cache (liveness via
  dept_who, full text via agent_messages, writes via send_message, dept_sleep);
  do NOT re-read AGENTS.md or the full ROADMAP or
  list state dirs (the journal is the memory) → present the session plan to the
  owner.
- **WORK**: load the `dsh-plugin-dev` skill; atomic tasks; TIERED
  verification; independent review after every change.
- **WEB-FETCH HABIT**: the Asistente defaults `web_fetch` to API/JSON endpoints (registry.npmjs.org, api.github.com, cdn.jsdelivr.net), retries once on transient 502/429, and never trusts truncated HTML shells of Cloudflare-walled pages — cheatsheet: `.dsh/reports/scribe/2026-08-17-webfetch-endpoint-habit.md`.
- **END**: green verification, commit with the repo's style (`git log
  --oneline -5` to see it), status updated in `docs/ROADMAP.md` if
  applicable.
