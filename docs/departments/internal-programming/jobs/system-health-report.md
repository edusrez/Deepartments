---
id: system-health-report
title: System health daily report
role: builder
description: Daily system-health digest: service units, endpoints (HTTP 200 dev local), repo git statuses, delivery-failure + post-error counts, plugin/DSH versions vs published; report to the Internal Programming Head.
schedule: '0 7 * * *'
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-system-health.md
---

# System health daily report

Task for the worker the Internal Programming Head materializes with this job
(role: `builder` — persona:
`presets/departments/internal-programming/builder.md`; the general protocol —
plan first, implement, verify, report — is that persona's, this body is the
concrete task).

## Objective

Produce a daily **system-health digest** of the deployment the owner can act on
(W6, owner request 2026-08-23 — "monitorizar que todo va bien"): confirm the
service units are alive, the DEV endpoints answer HTTP 200, the three in-scope
repos are clean, no sustained delivery/error anomaly, and the deployed
plugin/DSH versions are the expected ones. The Asistente cannot be messaged by a
worker, so you report the digest to the **Internal Programming Head**, who
forwards it.

## What to check

1. **Service units (liveness — NO `systemctl`).** `systemctl` is DENIED by the
   `dept_exec` guard (command denylist) — you MUST NOT run it, and must NOT
   attempt to get around the guard. Determine liveness via ALLOWED means, in
   this order:
   - **Primary liveness: HTTP 200 on the DEV local endpoint(s)** (`web_fetch`;
     the dev web server serving this deployment).
   - **Process presence** via allowed commands (`ps`/`pgrep` on the unit's
     binary or the `node`/`tsx` process that serves the DSH dev web + the
     plugin), matched to the unit's expected working directory.
   - **Reading the systemd unit state files** if reachable (e.g.
     `/run/systemd/system/*.service`, `/etc/systemd/system/*.service`) — read
     only, to confirm the unit exists/Enabled — never `systemctl`.
   **Enabled/disabled reading (verified by the Asistente).** The unit's
   **is-enabled** state is read from the unit state files (a `[Installed]` /
   `WantedBy=` row + the symlinks in `/etc/systemd/system/*.wants/`), NOT from
   `is-active`: a unit can be **live while `is-enabled = disabled`** (e.g.
   started by a drop-in/override or manually). Report each unit's enabled state
   as read — do NOT assume `live ⇔ enabled` nor `disabled ⇔ down`.
   **Known-DEcommissioned unit `dsh-vanilla`.** The old vanilla web unit
   (`dsh-vanilla`, the pre-deepartments 3081 instance) is a **KNOWN
   DEcommissioned** unit: the Asistente verified its unit state — **`is-enabled
   = disabled`** (decommissioned by design, 2026-08-28). Treat it as
   **warn-NOT-escalate**: report it in the health table with a **warn** status
   + the verified reading (`dsh-vanilla: decommissioned — is-enabled disabled,
   expected; no escalation`), and NEVER put it on the ESCALATION list. A
   decommissioned unit whose state file read matches the expected `disabled` is
   HEALTHY-expected, not an anomaly.
   If the authoritative `systemctl is-active` state is strictly required for a
   unit, add it to the report's **ESCALATION** list instead of running it (only
   the Asistente/owner may run `systemctl`). Record the unit's name(s) as you
   actually verified them.
2. **Endpoints.** HTTP 200 on the DEV local URL(s) of this deployment
   (`web_fetch`; use the dev web server origin, not the public/stable one).
   Report each URL + its status. A non-200/redirect is a finding.
3. **Repo git statuses.** The three local repos
   `/home/esuarez/projects/{deepartments,dsh-smart-restart,dsh-tool-web-enhanced}`:
   `git status --porcelain` (allowed) → report per repo **dirty/clean** + the
   count of changed/untracked paths. No commits, no writes.
4. **Delivery-failure + post-error counts SINCE LAST RUN.** Read
   `<stateDir>/deliveries.jsonl` rows with `status:'failed'` and
   `<stateDir>/post-errors.jsonl` rows (the canonical runtime stateDir is
   ABSOLUTE `/.deepartments/` — NEVER the relative `.deepartments` form, which
   would resolve against your department-workspace cwd to a non-existent
   ghost tree; cite `/.deepartments/<file>`). Track the prior
   run's last-seen positions in a per-run ledger
   (e.g. `<workspacePath>/reports/builder/system-health-ledger.json`) so the
   **delta since last run** (count and the new failed messageIds / new
   postIds) is what you report, not the all-time total. On the first run (no
   ledger) note the baseline all-time counts and mark the delta as N/A.
   **Capture anchor (citas):** whenever the digest CITIES a post-errors count,
   include the capture clock — the post-errors file's read `updatedAt` (or the
   capture window, e.g. "since <last-run ts>") — so the reader always knows the
   COUNTING window the number is anchored to (post-errors rows are bounded by
   the 2h HEALTH_ERROR_WINDOW_MS + the 500-row cap; archive evidence lives in
   `post-errors-archive.jsonl`).
5. **Plugin/DSH versions vs published.** Use the `version-watch` npm/GitHub
   conventions (see
   `docs/departments/internal-programming/jobs/version-watch.md`): the repo's
   `package.json` versions and `/opt/dsh/.dsh-dev/*` (or `$DSH_HOME`) manifests
   vs `https://registry.npmjs.org/@deepseek-ai/dsh` (`latest`/`rc`) and
   `https://registry.npmjs.org/dsh-deepartments` (+ the plugins' dist-tags).
   Report the deployed vs published delta per package. **Never touch the stable
   profile `/opt/dsh/.dsh`.**
6. **Boot attribution (fb-43 — restart-registry + post-incidente 2026-09-04
   breaker datums).** ANTES de etiquetar cualquier boot como «sin explicar»/unexplained
   en el digest, consultar el restart-registry (`/.deepartments/restart-registry.jsonl`,
   mecanismo fb-43) y la atribución del Asistente (restarts deliberados con canary PASS) —
   correlacionar SIEMPRE el registry con los deploys registrados; un boot sin entrada de causa
   puede ser deliberado (deploy) o recovery (crash). Un crash con systemd
   on-failure (`Restart=on-failure`) aparece como boot sin atribución y NO debe
   marcarse «sin explicar» sin cruzar los post-errors del día (ítem 4).
   **Breaker datums (post-incidente 2026-09-04, crash-loop 609 restarts / exit 7):**
   leer el heartbeat `/.deepartments/health-heartbeat.json` — los campos
   opcionales `{ts, bootId, surface?, nRestarts?, crashStreak?, sweep?}` — y el sidecar
   `/.deepartments/boot-crash.json` (`{bootId, bootStartedAt, crashStreak,
   lastCrashAt?, recoveryCause?}` — el registro del crash PRE-tick: el arranque previo murió
   ANTES de un heartbeat sano; FB-234 (2026-09-08, canary-vs-crash): un re-boot
   INTENCIONAL del host (smart_restart canary — marker `restart-reason.json`
   causa `canary`/`deploy`/`dshmarket` previo al kill) NO incrementa el streak —
   ese boot aparece con `recoveryCause: "canary"` (copiado verbatim a la fila
   del restart-registry del boot sucesor) y el streak NO sube; un crash REAL
   vuelve a incrementar). Reportar en la línea de atribución por boot:
   **surface** (la superficie de sesión detectada: `0.1.2-rc.1` /
   `0.1.1-rc.2-legacy` / `both` / `none` — un drift código-vs-runtime aparece
   AQUÍ, antes del churn), **NRestarts** (el contador systemd que el daemon lee
   una vez por boot cuando `DEEPARTMENTS_SYSTEMD_UNIT` está configurado; si el
   heartbeat lo omite, dejarlo en la lista de ESCALATION para que el Asistente
   lo lea con `systemctl show <unit> -p NRestarts`) y **crashStreak** (≥ 3 =
   posible crash-loop en curso — escalar). **Sweep** (FINISHER 2026-09-04,
   addendum 4 — health datum for the fb-27 closure): the lane-② NO-boot
   redelivery sweep reports `sweep: {armed, cycles, lastCycleTs?,
   preparedStuckRemaining?}` — `armed` = the interval is active, `cycles` =
   completed `sweepDue` cycles, `lastCycleTs` = the last cycle,
   `preparedStuckRemaining` = the prepared-stuck (> 10 min) residue of the
   last cycle — **the CLOSURE criterion fb-27 is ACCIONABLE residue = 0**:
   discount from the integer the held-class the heartbeat already delivers
   (`dormantHeld` ∪ `noWakeHeld` ∪ `gatedHeld` — they cannot reach 0 by
   design: a dormant/no-wake/gated recipient drains at its next REAL wake),
   and escalate ONLY a residue those classes leave unexplained that persists
   ≥ ~8h (1 digest cycle) — transient congestion is never an escalation. A
   prepared row addressed to a RETIRED recipient (a post in posts.json or a
   host-session in hosts.json) is NOT a held-class residue — it is
   structurally non-terminalizable by the sweep and is settled by the
   operator-run mark-delivery CLI (fb-253, append-only 'terminal', ALTO-1
   guard): report it as an ACCIONABLE residue (visible via `posts.json` ∪
   `hosts.json`), never as dormant/no-wake/gated. If the heartbeat omits
   `sweep` (a composition without a sweep), report it as absent, never guess
   it.

## Report

Write the full digest to
`reports/builder/<YYYY-MM-DD>-system-health.md` (`reports/` = the department
workspace reports dir; your cwd is the department workspace), frontmatter in the
project report convention (`agent: builder`, `date`, `task: system-health-report`,
`spec_ref: docs/departments/internal-programming/jobs/system-health-report.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body:

- a **health summary table**: check (service liveness per unit / endpoints /
  repo git status per repo / delivery-failures delta / post-errors delta /
  versions) → status (ok / attention / escalation) → detail;
- the **delta counts** (since last run) for delivery-failures and post-errors,
  with the new messageIds/postIds;
- the **versions table** (package / deployed / published / delta / verdict);
- the **ESCALATION list** — anything that needs the Asistente (e.g. a unit whose
  authoritative state is unverifiable without `systemctl`) and any real anomaly.

Update the ledger file so the next run's delta is computable. Reference prior
report paths you build on (≤ 3 per category).

## Reply to the head

`send_message` to the Internal Programming Head with the **forward-ready
digest** (health-per-check, the delta counts, the versions table, escalate
Y/N + the escalation items, the report path). The head forwards it to the
Asistente. You report only to your head (ACL).

## Constraints

- **NEVER run `systemctl`** (or `systemctl is-active`/`reboot`/`sudo`/etc.) —
  the `dept_exec` guard denies them; a strictly-required authoritative state goes
  on the ESCALATION list.
- **Never touch the stable profile `/opt/dsh/.dsh`** — DEV profile only, and only
  read for manifests/versions.
- Read-only for the repos and the state dirs; no code edits, no commits.
- Every claim cited (URL + date for versions/endpoints). A source unreachable →
  record its CURRENT state, never guess.

## MEMO NORM (F3)

At the end of EVERY round, write `dept_memo_write` with the job's accumulated
state (results, decisions, anomalies, follow-up queue) so the next round picks
up where this one left off. Rounds are ephemeral — each round materializes a
FRESH worker with no carried state — and stale journals are the anti-pattern to
avoid (version-watch/monitor-dsh-updates stale since 2026-08-24): the memo is
the required continuity mechanism between rounds.
