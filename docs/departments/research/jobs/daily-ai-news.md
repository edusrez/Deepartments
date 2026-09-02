---
id: daily-ai-news
title: Daily AI news brief (fresh, de-duplicated)
role: researcher
description: Produce a daily morning brief of FRESH AI news (new model releases/launches, key benchmarks, notable services/APIs, software/harness frameworks) with primary sources, de-duplicated against the prior briefs, and hand the Research Head a 3-5 bullet summary.
schedule: '0 9 * * *'
owner: research-head
outbox: reports/daily-news/<YYYY-MM-DD>.md
---

# Daily AI news brief

Task for the worker the Research Head materializes with this job (role:
`researcher` — persona: `presets/departments/research/researcher.md`; the
general protocol — web-first investigation, citations, memo, sleep — is that
persona's, this body is the concrete task). The Research Head schedules this
job every morning at **09:00 GMT/UTC** (cron `0 9 * * *`); the brief flows to
the Asistente through the head.

## Objective

Produce a brief of **Fresh AI news** — new model releases/launches, key
benchmarks, notable services/APIs, and software/harness frameworks (including
agent harnesses) — each item with a **primary source (URL + publish date)**.
The owner reads it in the morning, so prioritize what materially changed in the
last ~**48h** and explain **why it matters** per item.

## Freshness (hard constraint)

- Only report items whose publish/announcement date is within the last
  **≤48h**. If you are unsure about an item's date, **discard it** (or record it
  as unverified — never guess a date).
- If there is nothing substantial from today/yesterday, report **"no notable
  news"** and set the brief status to `none` — do not pad the brief with old
  items.
- Be date-aware: confirm today's date first, and prefer items dated today or
  yesterday.

## De-duplication (hard constraint)

- **Read the ledger** `{{workspacePath}}/reports/daily-news/ledger.json`
  (structure `{ "seenUrls": [...], "seenTopics": [...] }`). Your cwd is the
  department workspace, so this is also `reports/daily-news/ledger.json`
  relative to cwd.
- Any URL already in `seenUrls` is **NOT** reported again (a prior brief already
  covered it) — do not re-report it, even if still fresh.
- **After** writing the brief, **update the ledger**: append the new URLs to
  `seenUrls` and the new topic slugs to `seenTopics` (one kebab-case slug per
  distinct topic covered this round), keeping it valid JSON. If the file does
  not exist, create it with the two empty arrays first.

## Search & sources

- `web_search` (use the available sections — Parallel fast / RAG / searxng), then
  `web_fetch` the promising primary sources. Use the **Parallel extract** fetch
  provider when available; otherwise the normal fetch.
- Prioritize **primary** sources: official repos, vendor/company blogs and
  announcements, model cards, and dated news/press. Cite both URL and date.
- A source that changed or is unreachable → record its CURRENT state, never
  guess.

## Report

Write the brief to `{{reportDir}}/daily-news/<YYYY-MM-DD>.md` (cwd = the
department workspace, so `reports/daily-news/<YYYY-MM-DD>.md`; `reportDir` is
the department workspace reports dir). Frontmatter in the project report
convention:

```yaml
---
agent: researcher
job-id: daily-ai-news
date: <YYYY-MM-DD>
topic: daily-ai-news
sources: <count of fresh primary sources cited>
status: fresh | none
---
```

Body:

- A **table** of the day's novelties: title / source / URL / date /
  **why it matters**.
- If there are none: a clear **"No notable news"** section instead, and the
  frontmatter status `none`.

## Archive (sources/)

- Every NEW primary source you rely on is also archived in the department source
  archive: `{{workspacePath}}/sources/<topic-slug>.md` (cwd-relative
  `sources/<topic-slug>.md`), per `docs/departments/research/SOURCES.md`. Consult
  the topic slug FIRST (glob/grep); if an entry exists, **EXTEND** it (add URLs,
  refresh `date`) instead of duplicating; if not, create one with the required
  frontmatter (`title`, `tags`, `urls`, `date`, `verified: false`, `notes`).

## Reply to the head

`send_message` to the Research Head: a concise 3–5 bullet summary — what's
fresh, the top 1–2 items and their "why it matters", the brief path, the ledger
path. The head forwards the consolidated brief to the Asistente (existing
protocol — the head's report reaches the host). You report only to your head
(ACL).

## Memo norm (F3)

Rounds are EPHEMERAL — every round materializes a FRESH worker with a new post
id and NO carried state (`daily-ai-news`, `daily-ai-news-2`, …) — so the memo
is the REQUIRED continuity mechanism between rounds. A stale job journal is the
anti-pattern to avoid (this job's journal went stale on 2026-08-24; after that
the accumulated state was carried only by the head's memo — the norm fixes the
hole).

- At the END of every round, write `dept_memo_write` with the job's accumulated
  state — results summary, decisions, anomalies, follow-up queue, report paths
  — so the next round picks up where this one left off. The memo lands at
  `<stateDir>/journals/<yourPostId>.md`.
- At the START of the round, before researching, search the journal store for
  this job's prior memos (glob `journals/daily-ai-news*`) AND the head's memo
  (`journals/research-head.md`) to pick up the carried state.

## Constraints

- Research-only: no code/repo changes, no commits, no builds. The brief, the
  ledger and any new source entries are the only files you write — all in the
  department workspace, **not** the repo.
- Freshness and de-duplication are hard constraints; when in doubt, exclude.
- Reference prior report paths you build on (≤ 3 per category), e.g. the
  previous brief `reports/daily-news/<YYYY-MM-DD>.md` and the ledger.