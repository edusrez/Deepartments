---
agent: builder
date: 2026-08-23
task: system-health-spec
spec_ref: "Owner request 2026-08-23 \u201cmonitorizar que todo va bien\u201d (epic W6): dsh-deepartments gains a system-health layer so a silent incident (a failed bus wake, the session-persistence \u2018id collision\u2019 class, a failed delivery) can NEVER go unnoticed \u2014 failures must reach the Asistente by bus, which delivers to the owner by presence. Spec 006 documents the post-error capture seam, the health daemon, the bus-ALERT-to-Host pattern, and the daily digest job."
outcome: FINAL DRAFT (spec only, per the W6 documentation task) — no code edits, no commit, no other files touched
files_touched:
  - docs/specs/006-system-health.md (this draft)
  - docs/departments/internal-programming/jobs/system-health-report.md (job def)
error_type: none (design doc — no build/test required)
key_findings:
  - The runtime is INTENDED to land in src/invoke.ts + src/org.ts; at spec time runHealthDaemonTick/health config had NOT yet landed (grep found no matches) — the spec documents the INTENDED contract the code implements.
  - The health daemon mirrors the two existing plugin daemon patterns (agenda scheduler runAgendaSchedulerTick + parallel-monitor createParallelMonitorDaemon) and their reversible ctx.effect wiring (~invoke.ts 7649-7820).
  - A plugin daemon is NOT a catalog member, so the bus ACL would conservatively deny an alert to the host; the daemon must deliver via the post/host-delivery seam directly (busDeliverToPost / busDeliverToHost), framed `[From deepartments]`, exactly like the agenda scheduler's notifyHead and the parallel-monitor's notifyHead.
  - Dedup is PERSISTED (health-alerts-state.json): ≤1 alert per postId / per messageId per 30min, so a repeated boot/loop of the same post does not re-alert the Asistente every tick.
  - Heartbeat is a SEPARATE externally-read signal (health-heartbeat.json `{ts,bootId}`) because the alert path is anomaly-gated; heartbeat proves the daemon is alive even when nothing is wrong.
  - The daily digest job must NEVER attempt systemctl (dept_exec denies it); liveness is HTTP-200 (dev), process presence, and unit-file reads, with a strictly-required systemctl state escalated to the head.
---

# The System-Health layer — design spec (W6)

Status: **FINAL DRAFT — the design below is the INTENDED contract of the W6
system-health runtime that a parallel code worker is landing in `src/invoke.ts` +
`src/org.ts`.** At spec time the runtime symbols (`runHealthDaemonTick`,
`health` config) had NOT landed — grep over `src/invoke.ts` / `src/org.ts`
returned no match for them — so this spec documents the contract those sources
are implementing, and each section cites the EXISTING anchor (daemon pattern,
bus seam, delivery row) it builds on. `❓` marks a builder-verify point
(implementation detail deferred to the code/verify worker). All `src/` line refs
were verified against the working tree at spec time; they may drift as the
code lands.

---

## 1. Context & Motivation

The owner wants **zero-silent-incident monitoring** (2026-08-23, "monitorizar
que todo va bien"): the Deepartments runtime must be able to *tell the operator
(by presence, at the Asistente) that something broke* — without it relying on a
human noticing. Today the plugin's contracts are deliberately non-throwing: the
bus delivery seams **never throw** — `busDeliverToPost` (invoke.ts:6584) and
`busDeliverToHost` (invoke.ts:6617) both catch, `ctx.logger.warn`, and return
`'failed'`. That makes a wake/resume failure a **WARN in the plugin log**, not a
signal the owner sees. If the harness session-persistence layer throws in the
create/resume/wake seam (the "id collision" class — a session already exists at
the target id), the message is silently dropped to a warn.

Three distinct failure surfaces deserve monitoring:

1. **Post-error capture** — a head/worker session create/resume/wake that
   *throws* in the bus materialization seam. This is the "silent" class: the
   message is neither delivered nor visible to the owner, only a warn.
2. **Delivery failures** — a message recorded as `status:'failed'` in the
   write-ahead delivery sidecar (`<stateDir>/deliveries.jsonl`, messages-store
   §4.4). A durable row exists, so this is already *observable* but not *acted
   on*.
3. **A live-deployment heartbeat** — does the daemon itself still run? A monitor
   that dies is itself a silent incident, so the monitor must publish a
   freshness signal that is checked externally.

The design has **two cooperating parts**:

- an **impulse-capture seam** (post-errors.jsonl) that records the silent
  failures at the exact point they occur;
- a **health daemon** that periodically reconciles the logs into a few
  externally-checkable artefacts (heartbeat + alerts) and pushes an ALERT to the
  **Asistente (host) by bus** when an anomaly is current — the bus delivers to
  the owner by presence (waking the host, which the owner sees).

A third, **human/operator** part — the **daily digest job**
(`system-health-report`) — runs once a day to answer "is everything well"
holistically (service liveness, endpoints, repo git status, version drift) and
reports to the head.

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — Post-error capture.** In the bus materialization/wake seam catch
   blocks, append a bounded record of every create/resume/wake throw to
   `<stateDir>/post-errors.jsonl` (never throw; the existing
   never-throws contract is preserved).
2. **G2 — Health daemon.** A pure, injectable-clock tick that runs every
   `health.intervalMs ?? 60000` and, on each tick, (a) writes a heartbeat
   `<stateDir>/health-heartbeat.json`, (b) scans the fresh error rows +
   failed-delivery rows, and (c) alerts on an anomaly.
3. **G3 — Bus ALERT to the Asistente.** On an anomaly the daemon delivers a bus
   message to the **host** framed `[From deepartments] System-health ALERT:
   <grouped findings>`, deduped (≤1 per postId / per messageId per 30min) so a
   repeated loop does not re-alert every tick, and audits it to
   `<stateDir>/health-alerts.jsonl`.
4. **G4 — Config.** `health: { enabled?: boolean (default true), intervalMs?:
   number }` in the org config; `enabled:false` → **no daemon, no heartbeat**
   (the whole layer is a no-op).
5. **G5 — Daily digest.** A `builder` job (`system-health-report`, cron
   `0 7 * * *`) that reports service liveness / endpoints / repo git dirty /
   delivery-failure + post-error deltas / version drift to the head.

### Non-Goals (explicit)

- **No auto-remediation** — the daemon alerts; it never repairs, restarts,
  disposes, or wakes anything on its own.
- **No new scheduler engine** — the daily digest reuses the existing
  job-run/dept_job_run machinery (spec 004 §5.7); the daemon reuses the existing
  daemon/effect machinery.
- **No change to the bus never-throws contract** — the post-error capture is an
  ADDITIVE side record inside the existing catch blocks; the seams still return
  `'failed'` and still `ctx.logger.warn`.
- **No touching the stable profile `/opt/dsh/.dsh`** and no `systemctl` for the
  digest job (that is the Asistente's scope only).
- **No human-facing dashboard** in this epic — the artefacts are JSON/JSONL that
  an external check or the digest consumes.

---

## 3. Conceptual model (the four artefacts)

All under `<stateDir>` (org config `stateDir`, default `.deepartments`):

| Artefact | Kind | Payload | Purpose | Bounded? |
|---|---|---|---|---|
| `post-errors.jsonl` | JSONL, append-one-per-event | `{ ts, postId, messageId?, error }` | durable record of a bus create/resume/wake throw, at the point it happens | **yes — keep last 500 lines, compacted on write** |
| `deliveries.jsonl` | JSONL, append (EXISTING, spec §4.4) | `{ messageId, recipientId, status, ts }` | write-ahead delivery sidecar; the daemon **scans** this for `status:'failed'` | yes (boot compaction, existing) |
| `health-heartbeat.json` | JSON, truncate-on-write | `{ ts, bootId }` | externally-checkable freshness of the daemon; proves it is alive | single object |
| `health-alerts.jsonl` | JSONL, append-one-per-alert | `{ ts, findings[], dedupeKeys[] }` | audit trail of every bus alert sent | no (small; alert-gated) |
| `health-alerts-state.json` | JSON, truncate-on-write | `{ postId/postKey → { alertTs } , messageId/messageKey → { alertTs } }` | persisted dedupe map enforcing ≤1 alert per postId / per messageId per 30min | single object |

`bootId` is a per-process epoch id generated **once per plugin apply** — a
`randomUUID()` (invoke.ts:8177 `const healthBootId = randomUUID()`), stamped as
`{ ts, bootId }` into the heartbeat, so it is distinguishable per boot. The
heartbeat is intentionally a **separate** artefact from the alert
path: a daemon can be alive without any anomaly, and an external freshness check
should be able to confirm "running + nothing wrong" (heartbeat fresh) versus
"daemon died" (heartbeat stale) without conflating it with an anomaly.

---

## 4. The POST-ERROR CAPTURE seam

**Where.** The two bus materialization seams in `src/invoke.ts`:
`busDeliverToPost` (invoke.ts:6584) and `busDeliverToHost` (invoke.ts:6617).
Both already have the exact shape the capture needs:

```
try {
  const live = agents?.get(sessionId)
  // … stuck-head recovery (busDeliverToPost only) …
  const { target, resumed } = await materializePost(entry)   // ← create/resume/wake
  target.followup(busUserMessage(record, framed, senderSessionId))
  return resumed ? 'resumed' : 'delivered'
} catch (error) {
  ctx.logger.warn(`[deepartments] bus delivery to "${entry.postId}" failed: …`)
  return 'failed'                                             // ← never throws
}
```

**The intended contract.** Inside the `catch` block, BEFORE the
`ctx.logger.warn`/`return`, append one line to `<stateDir>/post-errors.jsonl`:

```
{ ts, postId, messageId?, error }
```

- `ts` — `Date.now()` at capture.
- `postId` — the delivery target (`entry.postId` for a post, `hostEntry.hostId`
  for a host).
- `messageId` — `record.id` when available (the durable message being
  delivered); optional for a wake/resume that failed before a record is
  materialized.
- `error` — the thrown value, stringified (`error instanceof Error ?
  error.message : String(error)`), the same folding the existing warn uses.

**Bound.** The file is bounded to the **last 500 lines**, compacted on write
(write the retained tail back to the same path). This keeps the file small and
bounded in a hot/looping path, and matches the existing delivery-sidecar boot
compaction habit (messages-store §4.4).

**Invariants preserved:**
- The seam still **never throws**; a failure to append the error row must not
  break delivery — wrap the append in its own try/catch that degrades to a warn.
- The seam still returns `'failed'` as today; this is an additive side record.
- The recorded error is captured at the **same** place the existing
  `ctx.logger.warn` fires, so "an error was logged" and "an error row was
  written" stay in lock-step.

---

## 5. The HEALTH DAEMON

### 5.1 Factory + pure tick

Mirror the two existing daemon factories: `runAgendaSchedulerTick`
(invoke.ts:1665, the agenda scheduler) and `createParallelMonitorDaemon`
(invoke.ts:2037, the parallel-monitor). The intended shape is a **pure
injectable-clock tick**:

```
runHealthDaemonTick(deps): Promise<void>
```

with deps carrying `now`, `stateDir`, `bootId`, `hostId`/`hostEntry`
(the alert target), the `messagesStoreReady`/store, `busDeliverToHost`, the
`logger`, and the resolved `health` config. The "pure injectable-clock" contract
(the same reason `runAgendaSchedulerTick` and the parallel-monitor `tick` take
`now`/`departments` stubs) is that **a test drives the tick directly** with a
fixed `now` and stubbed hooks, so the scan/dedupe/alert flow is deterministic
and offline.

### 5.2 Per-tick behavior

Each tick (every `health.intervalMs ?? 60000`):

**(a) Heartbeat.** Write `<stateDir>/health-heartbeat.json` = `{ ts, bootId }`
(truncate the previous file). This is the externally-checkable freshness signal:
fresh `ts` (`now - ts` small) + the current `bootId` ⇒ the daemon is alive and
belongs to this boot. The heartbeat is written **regardless of whether any
anomaly is found** — that is precisely its job.

**(b) Scan post-errors.** Read `<stateDir>/post-errors.jsonl` rows with
`ts ≥ now - 2h` ("fresh ≤2h"). Dedup: **per `postId`** within a `30min` window
— i.e. only one alert per distinct postId per 30 minutes, so a repeated
create/resume/wake throw on the same post does not spam the Asistente every
tick. Group the fresh, deduped rows into a compact finding per postId.

**(c) Scan delivery failures.** Read `<stateDir>/deliveries.jsonl` rows with
`status:'failed'` (via the existing `parseDeliveryRows`, messages-store.ts:506)
and `ts ≥ now - 2h`. Dedup: **per `messageId`** within a `30min` window. Group
the rows into a compact finding per messageId. **W7-A note: a
`status:'terminal'` row is by definition NOT a failure and is NEVER re-attempted
(a dead/unknown recipient settled once by the boot re-delivery driver), so the
scan's `status === 'failed'` filter naturally leaves it out — a terminal row can
never become a `delivery-failed` alert (see the W7-A addendum below).**

**(d) Alert.** If any grouping non-empty, build a grouped finding text
(`<grouped findings>` — e.g. "N post-error(s): post A (2×), post B (1×); M
failed delivery(ies): msg X (1×), msg Y (2×)"), then:

1. **Dedup gate** against the persisted map `<stateDir>/health-alerts-state.json`:
   skip posting if the same postId/messageId was already alerted within the last
   30 min; otherwise record this alert time and persist the map.
2. **Send the bus ALERT to the host** framed EXACTLY
   `[From deepartments] System-health ALERT:\n<bullet lines>` (see §6) — one
   `- post-error: <postId> (<count> in window): <error>` /
   `- delivery-failed: <messageId>` bullet per finding; the delivery-failed
   count is always 1 (per-messageId dedupe, last-wins).
3. **Audit** `<stateDir>/health-alerts.jsonl` (append one line with
   `{ ts, findings[], dedupeKeys[] }`).

**`enabled:false`** → the daemon is not started at all: **no tick, no heartbeat,
no alert, no audit** (an explicit opt-out for a deployment that wants the layer
silent).

---

## 6. The bus-ALERT-to-Host pattern

The daemon is **NOT a catalog member** — it is a plugin daemon, like the agenda
scheduler and the parallel-monitor. Therefore the bus ACL **would conservatively
deny** any alert it tries to send (spec 004 §5.6 gates the catalog route, and a
daemon has no catalog member profile). The two existing daemons solve this
identically, and the health daemon must reuse the same seam:

- agenda scheduler `notifyHead` (invoke.ts:7688-7698): `store.append({from:
  'deepartments', to:[headPostId], text, kind:'agent'})` then `busDeliverToPost(head,
  '[From deepartments → …]: …', record, void 0)`.
- parallel-monitor `notifyHead` (invoke.ts:7805-7814): identical
  `store.append`…`busDeliverToPost` shape.

**The intended health pattern** mirrors it, but targets the **host** via
`busDeliverToHost` (invoke.ts:6617) instead of a head via
`busDeliverToPost`:

```
const store = await messagesStoreReady
const frame = buildHealthAlertFrame(findings) // EXACTLY
  // `[From deepartments] System-health ALERT:\n- <bullet>` — one
  // `- post-error: <postId> (<count> in window): <error>` /
  // `- delivery-failed: <messageId>` bullet per finding (delivery-failed
  // count is always 1: per-messageId dedupe, last-wins).
const record = await store.append({ from: 'deepartments',
  to: [hostEntry.hostId], text: frame, kind: 'agent' })
await busDeliverToHost(hostEntry, frame, record, void 0)
```

`busDeliverToHost` (invoke.ts:6617) is exactly the right delivery: a **live host
is followed up inline**, a **dormant host is always woken** (resume + followup),
and it **never throws** — so an alert attempts delivery even when the Asistente
is off and guarantees the owner sees it by presence on the next wake. The
`from:'deepartments'` + `kind:'agent'` + `[From deepartments]` framing matches
the existing daemon notices, so it is a first-class bus message with durable
delivery semantics.

The host entry is resolved the same way the recipient map resolves a host id:
`hosts.get(hostId)` (invoke.ts:6853-6860) / `pickLiveHostEntry` for the live one.

---

## 7. The config `health` schema

Add a `health` section to the org config, mirrored by the `Config` schema in
`src/org.ts` (which already holds the runtime+mirror pattern for `parallel` —
org.ts:94/149-180):

```
health: {
  enabled?: boolean   // default true
  intervalMs?: number // default 60000
}
```

Schema intent (mirroring the `parallel` resolver contract):

- `enabled` ABSENT → **code default `true`** (the layer runs on the dev profile
  without touching the config). `enabled:false` → explicit opt-out (no daemon, no
  heartbeat). `enabled:true` explicit → runs.
- `intervalMs` ABSENT → **`60000`** (code default). Present → the tick period.

The runtime resolution follows the established pattern: read `(config as
unknown as { health?: … }).health`, fall back to defaults for absent keys, and
the schema + the typed cast always agree (same as `parallel`).

---

## 8. The DAEMON factory + reversible effect

The production wiring is a **reversible effect** under `ctx.effect` (AGENTS.md
rule 4 — the interval is cleared on dispose), registered alongside the existing
daemon effects:

- agenda scheduler: `ctx.effect(() => { const i = setInterval(tick,
  AGENDA_SCHEDULER_INTERVAL_MS); return () => clearInterval(i) },
  'deepartments: agenda scheduler daemon')` (invoke.ts:7657-7715).
- parallel-monitor: `ctx.effect(() => { const i = setInterval(() =>
  void daemon.tick(), PARALLEL_MONITOR_INTERVAL_MS); return () => clearInterval(i) },
  'deepartments: parallel-monitor daemon')` (invoke.ts:7816-7819).

**The intended health wiring** is the same:

```
if (health.enabled) {
  ctx.effect(() => {
    const i = setInterval(() => { void runHealthDaemonTick({ … }) },
      health.intervalMs ?? 60000)
    return () => { clearInterval(i) }
  }, 'deepartments: system-health daemon')
}
```

with `enabled:false` → the effect is not registered at all (no daemon, no
heartbeat). The effect label is the exact reversible-effect key
`'deepartments: system-health daemon'`.

---

## 9. The DAILY DIGEST JOB

A **`builder`** job, cron `'0 7 * * *'`, owner `internal-programming-head`,
declared in
`docs/departments/internal-programming/jobs/system-health-report.md`
(`id: system-health-report`). It is the human/operator counterpart of the
daemon: a once-a-day consolidated health digest the owner can act on. The worker
(role `builder`) checks, and reports to the head (never the host — worker → host
is PROHIBITED):

1. **Service units — liveness WITHOUT `systemctl`.** `systemctl` is DENIED by the
   `dept_exec` guard; the worker MUST NOT run it. Liveness via allowed means:
   **HTTP 200 on the DEV local endpoint** (primary, `web_fetch`), **process
   presence** (`ps`/`pgrep` for the serving binary + cwd), and **reading the
   systemd unit state files** if reachable. If an authoritative
   `systemctl is-active` is strictly required, it goes on the **ESCALATION**
   list (only the Asistente/owner may run `systemctl`).
2. **Endpoints** — HTTP 200 on the DEV local URL(s) of this deployment
   (`web_fetch`).
3. **Repo git statuses** — `git status --porcelain` on
   `/home/esuarez/projects/{deepartments,dsh-smart-restart,dsh-tool-web-enhanced}`
   → dirty/clean per repo.
4. **Delivery-failure + post-error counts SINCE LAST RUN** — read
   `<stateDir>/deliveries.jsonl` `status:'failed'` rows and
   `<stateDir>/post-errors.jsonl` rows; a per-run ledger
   (`<workspacePath>/reports/builder/system-health-ledger.json`) tracks the prior
   run's last-seen positions so the **delta** is reported, not the all-time
   total.
5. **Plugin/DSH versions vs published** — the `version-watch` npm/GitHub
   conventions (registry dist-tags + `/opt/dsh/.dsh-dev` / `$DSH_HOME`
   manifests) → deployed vs published delta.

Output: `reports/builder/<YYYY-MM-DD>-system-health.md` + the ledger, and a
**forward-ready consolidated digest** replied to the head (who forwards it to the
Asistente).

---

## 10. TESTS + acceptance

The unit/verify strategy follows the daemon/rule "the pure tick is testable"
habit. Acceptance criteria (the simulation chain):

1. **Failure → post-errors.jsonl.** Simulate a bus create/resume/wake throw on a
   post (e.g. the harness session-persistence "id collision" class) →
   `post-errors.jsonl` gains one `{ ts, postId, messageId?, error }` row; the
   `busDeliverToPost`/`busDeliverToHost` seam still returns `'failed'` and never
   throws.
2. **post-errors.jsonl → daemon alert → bus ALERT to Asistente.** A fresh
   (≤2h) post-error row is scanned; the daemon posts a
   `[From deepartments] System-health ALERT: …` bus message to the **host** via
   `busDeliverToHost`; `health-alerts.jsonl` gains an audit line;
   `health-alerts-state.json` is updated.
3. **≤1 per postId / per messageId per 30min.** Re-running the tick (or multiple
   throws on the same post) within 30 min does NOT re-alert the same postId /
   messageId — the dedupe map gates it.
4. **Heartbeat written.** Every tick writes `health-heartbeat.json` =
   `{ ts, bootId }` even with zero anomalies; the freshness check passes.
5. **Config toggle.** `health: { enabled: false }` → NO daemon, NO heartbeat file
   written, no alerts — the whole layer is a no-op.
6. **Full suite green + count grows.** The test suite for the touched area passes
   (`node --test` in the repo), and the scenario-count grows (the new health
   tests are added on top of the existing daemon/store tests, not a replacement).

---

## 11. Risks / patterns to watch

- **A monitor that dies is itself a silent incident.** The heartbeat (G2a) is the
  guard: the daemon is externally-checkable even when nothing is wrong, so a
  stopped daemon is observable. The digest job (G5) is the daily backstop.
- **Alert storm.** Without the persisted 30-min dedupe, a looping session throw
  alerts the Asistente every tick. The dedupe map is the anti-storm. The map must
  be **persisted** (survive a restart) and bounded.
- **Never throw in the capture seam.** The bus seam never-throws is a core
  invariant; the error-row append must be wrapped so it cannot break delivery.
- **Daemon ≠ catalog member.** The ALERT must go through the direct
  post/host-delivery seam, NOT the ACL catalog route (which denies a daemon). Reuse
  the agenda/parallel `notifyHead` pattern verbatim, with `busDeliverToHost` for
  the host target.
- **`enabled` default.** Absent `health` must NOT break existing configs — the
  default is code-side (`enabled:true`, `intervalMs:60000`), so a config with no
  `health` section composes untouched.
- **STABLE is a hard boundary.** The daemon writes only under `<stateDir>`; the
  digest job reads only DEV/`$DSH_HOME` and NEVER the stable profile
  `/opt/dsh/.dsh`. No `systemctl`.

---

## 12. W7-A ADDENDUM — terminal status of dead-recipient deliveries

**Problem.** The bus re-attempts delivery at EVERY boot for messages to
dead/unknown recipients (removed/closed/retired sessions — e.g. formerly-open
subagents whose session is gone): the boot re-delivery driver
(`redeliverPendingDeliveries`, invoke.ts) re-runs every pair whose latest sidecar
status `needsRedelivery(...)` (messages-store `status` null / `'prepared'` /
`'failed'`), and `deliverBusRecord` re-attempts even when the recipient is no
longer a live catalog member. Each boot re-attempt appends a NEW `'failed'`
sidecar row → the W6 health daemon (§5.2c) re-alerts every boot — persistent
noise with no recovery path.

**Fix (behavior for VALID recipients unchanged).** A delivery pair's status
gains a **`'terminal'`** value (`DeliveryStatus` union, messages-store.ts): the
runaway state for a pair whose recipient is no longer a live catalog member.
`needsRedelivery('terminal')` returns `false` (settled — never re-delivered).
The boot re-delivery driver resolves each re-attempt-eligible recipient against
the durable catalog (non-retired `posts.json` ∪ non-retired `hosts.json`) BEFORE
re-attempting: a **DEAD/UNKNOWN** recipient (neither exists, or its post/host is
retired / session closed-archived) is settled once by appending a SINGLE
`'terminal'` row via `markDelivery(stateDir, messageId, recipientId, 'terminal')`
and the bus re-wake is **SKIPPED** (no `deliverBusRecord` call → no fresh
`'prepared'`/`'failed'` rows). A **VALID** recipient keeps today's behavior —
still delivered/resumed/failed, still re-attempted when `'prepared'`/`'failed'`.

Because the sidecar is append-only and `deliveryStatus` reads the LAST row per
(`messageId`, `recipientId`), one settled `'terminal'` row makes the pair's
latest status `'terminal'`, so `needsRedelivery` is `false` on every subsequent
boot — the noise stops after one boot. An already-`'terminal'` row stays
terminal across restarts.

**Consequences for the health daemon.** `scanDeliveryFindings` (§5.2c) filters on
`status === 'failed'`, so a `'terminal'` row is never an anomaly. The daemon
therefore stops re-alerting a settled dead-recipient pair; the OLD pre-settle
`'failed'` rows age out of the 2h window on their own (no fresh `'failed'` row is
produced, so no new alert).

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept**: the bus seams still NEVER throw and still return
  `'failed'`; the capture is an additive side record; the daemon is a plugin
  daemon (NOT a catalog member), so it delivers via the direct seam framed
  `[From deepartments]`; the effect is reversible (`ctx.effect` clearInterval on
  dispose); a config without `health` keeps composing (code-side defaults); the
  STABLE profile `/opt/dsh/.dsh` and `systemctl` are untouched/denied.
- **Patterns reused** (cite them, don't reinvent): the plugin-daemon
  factory + reversible-effect wiring (agenda scheduler invoke.ts:7649-7715,
  parallel-monitor invoke.ts:7717-7820); the pure injectable-clock tick
  (`runAgendaSchedulerTick` invoke.ts:1665, `createParallelMonitorDaemon`
  invoke.ts:2037); the **daemon-not-a-catalog-member** notify seam (agenda
  notifyHead invoke.ts:7688-7698, parallel notifyHead invoke.ts:7805-7814 — both
  `store.append(...)` → `busDeliverToPost(...)`, the health daemon targets the
  host via `busDeliverToHost` invoke.ts:6617); the delivery-row parse
  (`parseDeliveryRows` messages-store.ts:506) and the delivery sidecar itself
  (messages-store §4.4).
- **Surprises**: (1) the bus ACL would **deny** a daemon's alert — the
  catalog-membership gate is the whole reason the daemon must post through the
  direct deliver seam; (2) the heartbeat must be a **separate** artefact from the
  alert path (a daemon can be alive with nothing wrong — the externally-readable
  freshness check is distinct from anomaly detection); (3) the session-persistence
  "id collision" throw class lives in the create/resume/wake — the capture must
  sit in the seams that materialize the post/host, not in a downstream
  followup; (4) the post-error file is **bounded** (last 500 lines) because a
  looping throw would otherwise grow it unbounded in the exact scenario the
  daemon exists to surface.
- **Primary source anchors for the code/verify worker**:
  src/invoke.ts (busDeliverToPost 6584, busDeliverToHost 6617, recipient-map
  6853-6860, runAgendaSchedulerTick 1665, createParallelMonitorDaemon 2037,
  daemon wiring 7649-7820), src/org.ts (Config schema, `parallel` mirror
  94/149-180), src/messages-store.ts (§4.4 sidecar, parseDeliveryRows 506).
