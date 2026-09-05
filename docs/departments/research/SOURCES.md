# Research Department — `sources/` knowledge convention

The department keeps a curated **source archive** — a searchable, de-duplicated
knowledge base of the sources it has already verified — so a new task never
re-discovers what a previous task already found.

The archive lives in the **department workspace** `sources/` directory:
`<workspacePath>/sources/` (`<workspacePath>` =
`/root/.deepartments/departments/research` per config). It is NOT the repo; it
is runtime data, like the `reports/` archive.

## One file per topic

`<workspacePath>/sources/<topic-slug>.md` — a kebab-case topic slug, one file per
topic. A topic is a recurring or material subject the department investigates
(dsh releases, a given plugin, a market, a NPM scope, ...).

## Required frontmatter (every entry)

```yaml
---
title: <human-readable topic title>
tags: [ <kebab-case topic tags for RAG/lookup> ]
urls:            # the sources — ordered, then the record's metadata
  - <primary URL>            # (the canonical/primary source first)
date: <YYYY-MM-DD>           # when the entry was last verified
verified: <true|false>       # whether a reviewer verified the record
notes: <one line: what this topic's record covers / any caveat>
# ttl: <date>                # OPTIONAL — expire + re-verify after this date
---
```

`tags`, `urls` (ordered), `date`, `verified` and `notes` are the
metadata the researcher/reviewer roles operate on. `ttl` is optional: a
time-sensitive source (e.g. a release feed) may carry a `ttl` expiry; after it
passes, the entry must be re-verified and its `date`/`verified` bumped.

## Rules

- **Consult BEFORE web search.** A researcher/reviewer greps (or queries the RAG
  index, when available) `sources/` for the topic first, and reuses/cites
  existing records rather than re-fetching.
- **Archive what you discover.** Every source a role finds and relies on is
  recorded here — even if the task also wrote a full report.
- **Never duplicate.** `glob`/`grep` the topic slug first; if an entry exists,
  EXTEND it (add URLs/notes, refresh `date`) instead of creating a new file.
- **Content is metadata, not copies.** A record stores the URL, its
  verification state and notes — not the full fetched content. Re-fetch for the
  body; the record is for discovery and provenance.
- **Curation is the head's call.** Deletions/merges of topic records are
  decisions for the Research Head; the organizer may list candidates but never
  deletes on its own judgment.

## web_fetch domain reliability (press releases / news mirrors)

The knowledge-base class **domain → status → fallback** (fb-24): wire and
news-mirror domains behave differently from the datacenter IP of this
deployment's `web_fetch`. Verified datapoints from research rounds
(fb-96/97/98/102/103/104, 2026-09-03): a full fetch on a blocked/unreliable
domain burns the 30 s tool budget every round — consult this table BEFORE
fetching a press release, never after.

| Domain | Status | Observed behavior | Fallback |
|---|---|---|---|
| `businesswire.com` (www + secure) | **UNRELIABLE** | systematic 30 s timeout (fb-96/102/104) | one attempt max, then vendor primary |
| `tmcnet.com` | **BLOCKED** | HTTP 403 anti-bot (fb-97/103) | do not attempt; use mirror list |
| `zexprwire.com` | **BLOCKED** | HTTP 403 anti-bot (fb-98) | do not attempt; use mirror list |
| `01net`, `finance.yahoo.com`, `cionfluence.com` | reliable mirrors | HTTP 200 from this environment (fb-96/98) | OK as last-resort mirrors |
| vendor primary (blog/repo/model card) | **preferred** | e.g. `ridgesecurity.ai` blog etc. (fb-103/104) | FIRST choice for press releases |
| API/JSON endpoints (`api.github.com`, `registry.npmjs.org`) | preferred | machine-readable (monitor-dsh-updates) | FIRST choice for registry/data |

**Fallback ordering for a press release** (documented researcher guidance,
fb-103/104): ① vendor primary (blog/repo/model card) → ② the issuing wire's own
page (`businesswire.com` — expect the timeout, one attempt max) → ③
known-working mirrors (table above) → ④ wire-syndication **search snippets**
(`web_search`) to confirm publication/date. Never guess a date or URL; record
the current state of any source that changed or is unreachable.

**Scope note:** `web_fetch` itself is harness tooling — this table is
documentation only, 0 code changes. A per-call configurable timeout /
automatic retry would be an upstream harness change (open, fb-102/104); the
table is the plugin-side mitigation (save the fetch budget).

## Index

`<workspacePath>/sources/INDEX.md` maintains the topic list (slug, title, tags,
`date`, `verified`). It is generated/updated by the organizer role
(weekly-report-organize) — do not hand-edit it.

## Relation

- Defined in `presets/departments/research/ARCHITECTURE.md` (knowledge system).
- The `researcher`/`reviewer`/`analyst` personas reference this directory; the
  researcher archives new sources; the reviewer verifies.
