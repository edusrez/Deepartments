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

- `package.json` — name `dsh-deepartments`, version `0.1.0-rc.1`, `type:
  module`, `main: lib/index.js`, `dsh.bundle` (patch → `cordis.patch.yml`),
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

## TIERED verification

1. `pnpm build` — tsc NodeNext compiles (src → lib), no type errors.
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add /home/esuarez/projects/deepartments` — installs the bundle in the development profile (isolated DSH_HOME `/opt/dsh/.dsh-dev`, never the default `/opt/dsh/.dsh` which is the stable instance).
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` — composes the tree WITHOUT booting; **must show the `# == dsh-deepartments` layer**.
4. Real headless smoke in the twin profile: `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev-headless "<prompt>"` (the GUI profile `deepartments-dev` rejects CLI prompt arguments).

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

Details and rationale for each rule: skill `dsh-plugin-dev`
(`.dsh/skills/dsh-plugin-dev/SKILL.md`).

## Environment variables

Runtime knobs read by the plugin (`src/invoke.ts`) — all OPTIONAL:

- `DEEPARTMENTS_QUALITY_INSPECT` — a numeric string in `[0,1]`; the **single
  documented override** of the quality-inspect dice probability (dec5): the
  worker-retire and QH-sleep dice (spec 007 §4.1/§5.2, D-Q2/D-Q7). When set and
  valid it wins over the `quality.workerInspectProbability` config value
  (priority: env > config > code default `0.10`); the structural NON-QH
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
