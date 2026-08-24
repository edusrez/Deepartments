---
id: quality-daily
title: Quality daily digest
role: quality-inspector
description: "Consolidate post-errors, stalled posts, delivery failures and prior inspection results into a once-a-day quality digest."
schedule: '0 8 * * *'
owner: quality-head
outbox: .dsh/reports/quality/<YYYY-MM-DD>-quality-daily.md
---

# Quality daily digest

Task for the worker the Quality Head materializes with this job (role:
`quality-inspector` — persona:
`presets/departments/quality/quality-inspector.md`; the general protocol —
BOOT-QUIET, messaging ACL, read-only, ephemeral-per-round — is that persona's,
this body is the concrete task).

## Objective

Consolidate the organization's runtime quality signal into a once-a-day digest:
the post-error deltas, stalled posts, delivery-failure deltas, and the previous
day's inspection results — the pattern report the QH folds into its
weekly/Asistente-facing report.

## What to read

1. `<stateDir>/post-errors.jsonl` — the spec-006 post-error capture (bounded
   500). Diff against the previous digest: what new post-errors appeared since
   the last run, and any recurring `postId`/`error` pattern (a symptom of a real
   bug).
2. `<stateDir>/deliveries.jsonl` — the delivery sidecar (messages-store §4.4).
   Filter `status: 'failed'` and diff against the previous digest: the
   delivery-failure delta.
3. The **archived session logs** (the retire/sleep/rotation artifacts under
   stateDir: `journals/sessions/*.md`, `journals/archive/`,
   `sessions/*.jsonl.zstd`) — look for a stale/leaked row, a post-error pattern,
   a delivery-failure thread, a head/host rotation that left an artifact. Use
   `read`/`glob`/`grep`; use `dept_exec` READ-ONLY to read the raw session
   artifacts (`sessions/*.jsonl.zstd`, `journals/archive/`) via the extended
   session-artifact root.
4. The **previous inspection results**: the prior digest (and any recent
   `quality-inspector` reports) under `.dsh/reports/quality/`. Reference the
   prior report paths you build on (≤ 3).

## Consolidate

Produce the digest sections:

- **Post-error delta** — new post-errors since the last run, with the recurring
  `postId`/`error` pattern (+ its likely cause if evident from the session logs).
- **Stalled posts** — posts that show as interrupted/stalled in the session logs
  (a reconcile/auto-run failure footprint).
- **Delivery-failure delta** — the `status: 'failed'` delivery delta since the
  last run (`deliveries.jsonl`).
- **Prior inspection results** — what the recent inspector reports found, and
  whether any signal is repeating.

## Report

Write the digest to
`.dsh/reports/quality/<YYYY-MM-DD>-quality-daily.md` — the stateDir/repo
`.dsh/reports/quality/` path (D-Q6), NOT the department-workspace `reports/`,
frontmatter in the project report convention (`agent: quality-inspector`, `date`,
`task: quality-daily`, `spec_ref: docs/departments/quality/jobs/quality-daily.md`,
`outcome`, `files_touched`, `error_type`, `key_findings`), then the body: the
four digest sections above.

## Reply to the head

`send_message` to the Quality Head with a CONCISE summary (the four digest
headlines + the report path). You report only to your head (ACL) — worker → host
(the Asistente) is PROHIBITED.

## Constraints

- Read-only inspection only: no code edits, no commits, no stable profile, no
  restarts. Never message the host directly (ACL) — report to the QH, which
  forwards to the Asistente.
- Every claim cited (file:line / report path); never guess.
- Reference prior report paths you build on (≤ 3 per category).
