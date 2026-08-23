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

## Index

`<workspacePath>/sources/INDEX.md` maintains the topic list (slug, title, tags,
`date`, `verified`). It is generated/updated by the organizer role
(weekly-report-organize) — do not hand-edit it.

## Relation

- Defined in `presets/departments/research/ARCHITECTURE.md` (knowledge system).
- The `researcher`/`reviewer`/`analyst` personas reference this directory; the
  researcher archives new sources; the reviewer verifies.
