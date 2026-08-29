# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-29

First **stable** release of the `dsh-deepartments` bundle (previous builds
were `0.1.0-rc.1` and were never published). This release consolidates the
whole agentic organization layer for DeepSeek Harness (DSH) — departments,
sleeping/waking posts, the durable messaging bus, the wake pack, witnesses,
activations and governance — and the complete **modular Cordis split**
(HITOS D5 + P1, 2026-08-29) that turns the former monolith into one bundle
plus eight `dshd-*` package plugins, alongside the 2026-08-28 release window
(issue realignment, delivery hardening, pacing, context monitoring).

### Added

- **Modular Cordis split — HITO D5 (2026-08-29)**: org double-truth resolved
  (`dshd-core` = shared source, bundle = fallback mirror, parity tests),
  the `tool-secretary` formalized as the single Cordis row for heads, and
  `dshd-gui` made the owner of the `deepartments-client` surface (the
  bundle's `./client` is a byte-identical mirror via
  `scripts/mirror-client.mjs`).
- **Modular Cordis split — HITO P1 (2026-08-29)**: the six library packages
  (`dshd-feedback`, `dshd-gui`, `dshd-health`, `dshd-jobs`, `dshd-pooler`,
  `dshd-quality`) are now **real Cordis plugins** — each with a
  `name`/`inject`/`apply` surface, its own `cordis.patch.yml` row and a lazy
  `deepartments.*` service with dependencies injected through the FASE 2.6
  Binder (missing dep at use → fail loud, R1). `feedback` and `quality` are
  functional today; the rest register their bucket and fail loud until the
  DECOUPLING hito fills the binder. Bundle composable in minimal mode
  (8 packages + `dsh-deepartments`).
- **fb-25 (QD ALTO, 2026-08-29)**: `verifyRotateReason` — cross-checks the
  head-rotated reason against the projection cache and stamps
  `reasonVerified` (never blocks) + session provenance (`sessionId`+`turn`)
  in post-error frames.
- **Pacing (peak/valley, 2026-08-28)**: pure `pacing.ts` module in
  `dshd-core` (UTC mirror of the dsh-key-pooler formula), `org.pacing.*`
  knobs, a `## Pacing (franja)` section in the wake pack, and durable
  peak→valley transition notices to the host (once per transition).
- **Ventana 08-28 batch**: `fb-9` realignment (compat route + preflight +
  resume + wire), ALTO-1/2 (delivery id-safe + host-session validation),
  M-A (`dept_head_rotate` + the `context-threshold` watchdog with banded
  dedupe), `dept_zstd_read` (bounded streaming window reads of .zstd
  artifacts), dispatch-hardening pre-checks, and post-errors archiving.
- **Watchdogs in `dshd-health`**: M1 (`pooler-capacity` + `qi-silence`
  anti-hang), M4 `system-idle` (alerts when pending work sits with no agent
  running for `idleWindowMs`), M-A `context-threshold` (alerts when a post's
  window usage crosses `contextThreshold`, default 50%).
- **Universal feedback store (AÑADIDO 1, 2026-08-26)**: `dshd-feedback`
  `FeedbackStore` + `dept_feedback`/`dept_feedback_list`/`dept_feedback_update`
  with severity-gated quality-head notification (critico → wake + interrupt,
  alto → wake, medio/bajo/mejora → no-wake queue).
- **Agenda & jobs engine**: calendar (`dept_calendar_add/list/remove`),
  cron scheduler, and the recurring jobs `weekly-repo-health`, `version-watch`
  and `system-health-report`.
- **W6 system-health**: post-errors capture, heartbeat/alerts ledger,
  daemon ALERT delivery to the host (`[From deepartments]`).
- **W4 owner presence**: presence toggle in the client header, RPC
  `presence/get|set`, `## Owner presence:` wake-pack state.
- **W7 terminal delivery**: deliveries to dead/retired recipients settle once
  to `terminal` (no re-alert noise); `agent/inbox/spliced` non-JSON fix
  (`toJsonSafe` in the 3 seams).
- **Health & quality extraction (PASO 9 DAG, 2026-08-27)**: `dshd-health`
  and `dshd-quality` extracted as pure libraries with same-module bridges
  (bundle keeps only effects/closures); later aligned to `dec5` 0.25 drop-in
  + `DEEPARTMENTS_QUALITY_INSPECT` env override.
- **M2 secretaries**: a single non-code `secretary` subagent surface for
  host + heads (`tool-secretary`), made visible in heads through the
  own-layer fix.
- **Face/net identity hardening**: `fb-6` AgentOptions fallback in
  materializePost + B5 forensic context; F-HIGH prompt/persona discipline
  batch; role-registry module-global → `deepartments.subagentRoles` service.
- **Operations tooling**: `scripts/session-hygiene.mjs` (dead-session census,
  dec4 zstd cold-tier compression, `--tmp` orphan sweep, stable-profile
  guard); P2 duration/key tooling per dept_exec scope rules.

### Changed

- **Version**: `0.1.0-rc.1` → `0.1.0` (first stable post-P1). The eight
  `packages/dshd-*` remain at `0.1.0-rc.1`; their inter-package peer graph
  (`^0.1.0-rc.1`) stays internally consistent, and the bundle's published
  dependencies (rewritten from `workspace:*`) resolve against that line.
- **Modularization (D5)**: the bundle's `deepartments-client` is now a
  byte-identical mirror of `dshd-gui`'s build; the org config has a single
  shared source (`deepartments.org`) with a fallback mirror.
- **P1 composition**: `dshd-feedback/quality/pooler/jobs/health/gui` compose
  as their own Cordis layers in the dev profile, with the `dshd-core` and
  `dsh-deepartments` sections byte-identical to the pre-P1 baseline (service
  resolution unchanged).
- **Toolset governance**: workers no longer expose `dept_feedback_list`/
  `dept_feedback_update`; host-only `workflow`/`ralph`/`goal` disabled by
  preset; `dept_who` defaults to active members (`scope: active|all`).
- **PeerDependencies** stay on the DSH rc channel
  (`@deepseek-ai/* ^0.1.0-rc.7 || ^0.1.1-rc.0`, `@deepseek-ai/cordis ^4.0.1`),
  matching the deployed harness line; CLI pin `npx -p @deepseek-ai/dsh@0.1.1-rc.2`.

### Fixed

- **RAG credential leak (fb-12/13/14/15, CRITICAL, 2026-08-28)**: live keys
  had been ingested verbatim into the RAG index via tool results; the index
  was purged (backup kept, R6), a content denylist was added to
  `dsh-tool-web-enhanced`, dedup was serialized, and a clean rebuild was
  verified by the Quality Department. Discipline fb-16: never dump
  credentials in journals/reports.
- **Delivery/registry fixes**: delivery row tail-reader (C6, byte-offset
  cursor, twin-safe), `prepared`-to-terminal settle for retired recipients,
  single-live host guard + refresh-merge on resume, loader cardinality WARN,
  stalled-post benign-end heuristic, and the `session not found` alert loop
  from dead host sessions.
- **Modular-split hygiene**: shared-source race fixed so posts.json pruning
  (C2) is deterministic; `dept_exec` guard hardened (arithmetic tokens,
  denied commands, stable-profile protection); client mirror byte-identity
  verified across builds.
- **Test stability**: `1b.1`/`m-64` de-flaked (0 skips), W9-b(d) teardown
  race closed; suite exact at **619 tests / 597 pass / 0 fail / 22 skipped**
  through HITO P1 (this release diff is version/docs only).

### Security

- Content denylist in the RAG/web-search layer prevents re-ingestion of
  credential-shaped content (fb-14/15).
- Credentials are never echoed by the pooler drop-in; the `ds-fallback`
  relay activates only on pool exhaustion with a health cooldown.

## [Unreleased]

### Changed

- (placeholder for the next release after the DECOUPLING hito / 0.2.x)