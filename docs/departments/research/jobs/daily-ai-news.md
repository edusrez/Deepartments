---
id: daily-ai-news
title: Daily AI news brief (fresh, de-duplicated)
role: researcher
description: Produce a daily morning brief of FRESH AI news (new model releases/launches, key benchmarks, notable services/APIs, software/harness frameworks) with primary sources, de-duplicated against the prior briefs, and hand the Research Head a 3-5 bullet summary.
schedule: '30 11 * * *'
owner: research-head
outbox: reports/daily-news/<YYYY-MM-DD>.md
---

# Daily AI news brief

Task for the worker the Research Head materializes with this job (role:
`researcher` — persona: `presets/departments/research/researcher.md`; the
general protocol — web-first investigation, citations, memo, sleep — is that
persona's, this body is the concrete task). The Research Head schedules this
job every morning at **11:30 GMT/UTC** (cron `30 11 * * *`); the brief flows to
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
- **The ledger is a cumulative file — extend it by FULL REWRITE via `write`**
  (the researcher toolset has NO `edit`, by design, fb-63/66): `read` the
  current ledger first, then `write` the complete updated JSON (old arrays +
  your appends). Re-read to verify valid JSON. This is the sanctioned
  "extend, never duplicate" pattern (fb-94/113/141) — never attempt `edit`;
  it fails with "unknown tool edit".

### THE DE-DUP UNIT IS THE ITEM — on BOTH axes (head's call, 2026-09-17)
**(fixes two rules that were each silently eating fresh material)**

**Read this whole subsection before excluding anything.** The ledger has TWO
arrays and each one, applied literally, suppresses material that is genuinely
new. Both failures have the same shape: **the ledger stores a CONSTANT (a fixed
URL, a subject name) and the rule treats that constant as if it were the ITEM.**

#### Axis 1 — a FIXED URL whose content ROLLS
**A fixed URL whose content rolls is de-duplicated by ITEM (version + date),
NEVER by URL.** The URL value is CONSTANT for such a surface, so a URL rule
suppresses it **forever after its first citation**. This is not hypothetical: it
cost **THREE consecutive rounds** of Claude Code releases, including 2.1.274
(Sept 17), the day's most harness-relevant release.

- **The rolling surfaces (check these EVERY round, even when their URL is
  already in `seenUrls`):** `code.claude.com/docs/en/changelog`,
  `github.blog/changelog`, `developers.openai.com/api/docs/changelog`,
  `mistral.ai/news`, `anthropic.com/news`.
- **How to apply it:** look for items NEWER than the one already recorded. A
  newer version/date ⇒ **REPORT IT**, and record the specific item (e.g.
  `code.claude.com/docs/en/changelog` @ 2.1.274 / 2026-09-17) so the next round
  can tell which items are already covered. If nothing is newer, say so.
- **The URL may still be appended to `seenUrls`** (harmless there): on a rolling
  surface it simply no longer suppresses anything.

#### Axis 2 — a TOPIC SLUG is a SUBJECT, not an item
**A topic slug in `seenTopics` suppresses the ITEM that was reported under it —
it does NOT suppress every FUTURE artifact belonging to that same subject.**
A slug such as `typesafe-system-one-jev` or `openai-misalignment-reports-index`
names a **subject**, and a healthy subject keeps producing new, separately
reportable artifacts (a vendor failure-mode page; a third-party open harness;
a new notice; a new release of the same product).

- **The question to ask is per-ARTIFACT, not per-subject:** *is this specific
  artifact — this page, repo, notice, version — already reported?* A **new URL
  that is not in `seenUrls` is presumptively NEW**, even when `seenTopics`
  already carries its subject. **Absence from `seenUrls` is the operative test;
  presence in `seenTopics` is NOT a veto.**
- **When you report such an item, append a NEW, MORE SPECIFIC slug** rather than
  leaning on the broad existing one (e.g. `typesafe-jev-post-launch-deltas`
  alongside `typesafe-system-one-jev`) — that is what keeps the record honest
  for the next round.
- **The settled/unswept boundary, stated so it is not over-read:** this does NOT
  reopen the *clauses of an already-covered launch* (a launch's price, dates and
  capability list, once covered, stay covered — do not re-report them as news).
  What it DOES keep open is **material that is new in its own right**: a new
  artifact, a new third-party build, a new disclosure, a new version. If the
  monitor item re-serves an old subject, **say plainly that its clauses are NULO
  as news and report only the genuinely new artifacts.**

#### Why both clauses live together
Exclusion is the default for anything already covered, and both axes are
**exceptions that WIN over it**. Historic case that proves the need for the
second one: the 2026-09-17 brief excluded a vendor's brand-new failure-mode page
and a real third-party harness build that called the live API. **Neither URL was
in `seenUrls` — the old URL rule would have admitted both. They were excluded by
the subject slug.** Same failure, other axis.

### Ledger counts (report the TRUE lengths — q-i-93, discipline of count)

- **Count from the FILE, never from memory or arithmetic on prior reports.**
  After the final `write`+re-read of the ledger, determine the real array
  lengths (q-i-93, round 09-07: a worker reported "165 URLs" while the durable
  JSON had 163 — 160 + 3 appended; cosmetic to de-dup, but the propagated
  counts were wrong).
- Reproducible method with the tools you have (no shell): use `grep` on
  `ledger.json` to find the line numbers of the first URL of `seenUrls` and the
  closing `]`, and of `seenTopics`; count the entries (or count by reading the
  whole file — the arrays are one entry per line). Simpler robust alternative:
  state the counts in the brief as **"URLs: <N> / topics: <M> — contados de
  reports/daily-news/ledger.json (líneas X–Y)"** so every round is auditable.
- Report those file-derived counts in the brief's "Ledger update" line (e.g.
  `157 → 163 URLs / 76 → 79 topics` — always `old+appended`, verified by
  re-read, not by adding rounded numbers).
- The counts are **discipline, not a hard constraint** (de-dup uses the URL
  values themselves, not counts) — but wrong counts degrade the audit trail;
  when in doubt, quote the file and the line range.

## Search & sources

- `web_search` (use the available sections — Parallel fast / RAG / searxng), then
  `web_fetch` the promising primary sources. Use the **Parallel extract** fetch
  provider when available; otherwise the normal fetch.
- Prioritize **primary** sources: official repos, vendor/company blogs and
  announcements, model cards, and dated news/press. Cite both URL and date.
- A source that changed or is unreachable → record its CURRENT state, never
  guess.
- **Fetch budget (fb-211, SOURCES.md domain table):** consult
  `docs/departments/research/SOURCES.md` § domain→reliability BEFORE fetching a
  press/news domain. Known from this environment: `openai.com` = 403 anti-bot
  (do not attempt; capture via search-provider content + dated secondaries),
  `aireleasetracker.com` = 429 rate-limited (one attempt max, then cross-check
  via search snippet), `businesswire.com` = 30 s timeout (one attempt max),
  `tmcnet.com`/`zexprwire.com` = 403 (do not attempt), `media.defense.gov` =
  403 (do not attempt; capture via search-provider + dated secondaries),
  `www.ainvest.com` = 403 (one attempt max, then search snippet). Table
  normally grows with each round — check it every time.
- **POSITIVE row worth knowing (round 09-17):** `alignment.openai.com` answers
  **200 with full text** even though the `openai.com` apex is 403 ⇒ use it as a
  **direct primary** for OpenAI's disclosures (e.g. `/misalignment-reports/`);
  do not confuse the two hosts.

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
- The **"Ledger update"** line must quote the FILE-derived counts (see
  "Ledger counts" above).

## Archive (sources/)

- Every NEW primary source you rely on is also archived in the department source
  archive: `{{workspacePath}}/sources/<topic-slug>.md` (cwd-relative
  `sources/<topic-slug>.md`), per `docs/departments/research/SOURCES.md`. Consult
  the topic slug FIRST (glob/grep); if an entry exists, **EXTEND** it (add URLs,
  refresh `date`) instead of duplicating; if not, create one with the required
  frontmatter (`title`, `tags`, `urls`, `date`, `verified: false`, `notes`).
- **EXTEND = `read` the entry, then `write` the complete new content** (old
  frontmatter/URLs + your additions), never a partial edit — the researcher
  toolset has NO `edit` (deliberate, fb-63/66), so `write` full-rewrite is the
  sanctioned pattern for cumulative source records (fb-94/113/141).
- For press-release press items, follow the researcher fetch guidance
  (`presets/departments/research/researcher.md` § Fetch guidance + the
  domain→status table in `docs/departments/research/SOURCES.md`): prefer the
  vendor primary blog/repo; `businesswire.com` times out and `tmcnet.com`/
  `zexprwire.com` 403 — do not burn fetches on them.

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
- At the START of the round, before researching, read this job's prior memos
  AND the head's memo to pick up the carried state. **Use the ABSOLUTE path:**
  the journal store is `<stateDir>/journals/` — concretely `/.deepartments/journals/`
  — which is NOT under the department workspace. `reports/` and `sources/` ARE
  workspace-relative; **journals are not**. So:
  `glob(pattern="daily-ai-news*.md", path="/.deepartments/journals")` and
  `read("/.deepartments/journals/research-head.md")`. A relative glob like
  `journals/daily-ai-news*` resolves against the workspace and returns NOTHING — that
  is a FALSE NEGATIVE, not an absent store. **The head's memo is the channel by
  which the head's standing policy reaches this job: if it cannot be read, the
  policy is unreachable and the job will re-ask questions already answered.**

## Constraints

- Research-only: no code/repo changes, no commits, no builds. The brief, the
  ledger and any new source entries are the only files you write — all in the
  department workspace, **not** the repo. (Exception: none — `SOURCES.md` and
  this job definition live in the repo and are curated by the head, not by the
  worker.)
- Freshness and de-duplication are hard constraints; when in doubt, exclude.
  **Exception, and it is the one that matters: the two de-dup axes above WIN
  over exclusion** — for a fixed-URL rolling surface or a new artifact under an
  already-seen subject, a NEW item is reportable.
- Reference prior report paths you build on (≤ 3 per category), e.g. the
  previous brief `reports/daily-news/<YYYY-MM-DD>.md` and the ledger.
