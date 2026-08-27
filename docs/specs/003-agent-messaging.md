---
agent: builder
date: 2026-08-22
task: agent-messaging-spec
spec_ref: "Owner decisions (2026-08-22, phase 2): replace the board (rooms + dept_room_write/read/who) with direct agent→agent messaging — one plugin-owned `send_message` (the harness native tool is DISABLED for deepartments agents), a durable `<stateDir>/messages.jsonl` store, `agent_messages` own-history tool, and `dept_who` (fusion of dept_room_who + dept_whereami, whereami deleted). Primary sources: explore-deep/2026-08-22-agent-messaging-design.md (bus map, keep/kill inventory, design sketch, risks), explore-deep/2026-08-22-head-machinery.md (ensureHead/wakePost/deps), docs/specs/002-host-session-rotation.md (spec style). Harness facts cited from the explore report's file:line trace (dsh-tool-subagent-control, dsh-subagent continuation.js, dsh-agent inbox.js, dsh-agent-loop, dsh-client-ui-conversation client.js)."
outcome: FINAL DRAFT (owner decisions adopted) — DRAFT-ONLY, no commit, no other files touched
files_touched:
  - docs/specs/003-agent-messaging.md (this draft)
---

# Agent-to-agent messaging — design spec (phase 2, replaces the board)

Status: **FINAL DRAFT — all decisions below are owner-approved (2026-08-22) and are
requirements, not proposals. Ready for builder dispatch (Batch B2 core, Batch B3 cleanup).**
`❓` marks the few builder-verify points where the exact seam is deferred to implementation.
All harness file:line facts come from the explore trace listed in `spec_ref`.

---

## 0. Owner decisions adopted (2026-08-22) — requirements, not proposals

| # | Decision | Baked in as |
|---|---|---|
| D1 | **Eliminate the board** (rooms, `dept_room_write`/`dept_room_read`, `dept_room_who`, board.jsonl, `org.rooms`) and establish direct agent→agent messaging. | §1, §2 G1, §7.1 |
| D2 | **One tool named `send_message`**, plugin-owned; the harness native `send_message` (parent→continuable-child adapter) is **disabled** for deepartments agents (host/head/worker presets). | §4.1 |
| D3 | **Store: `<stateDir>/messages.jsonl`**, append-only; record `{id, seq, ts, from, to[], text, kind: 'agent'\|'notice'\|'ack', threadId?, sensitive?}`; id `m-<n>`; globally contiguous `seq` → O(1) paging. Persistence mirrors the board-store pattern (flush-on-append, boot compaction). | §3 |
| D4 | **Catalog targets always wake** (owner policy: wake the recipient ALWAYS — including the host). The content is ALWAYS persisted to the store BEFORE any delivery (durable); re-delivery is idempotent. | §4.3 |
| D5 | **Tool `agent_messages`**: own history (only messages where self ∈ to[]); `{limit=10, before?}` (before = message-id cursor); `{total, messages, remaining}`; newest-first. **No read/seen marks in this phase.** | §5 |
| D6 | **Tool `dept_who`** = fusion of `dept_room_who` + `dept_whereami`: whole catalog (host + heads), each `{agentId, kind: 'host'\|'head', title, live, sleeping, sessionId?}`, own entry marked `you: true`. No `room` parameter. **`dept_whereami` is deleted.** | §6 |
| D7 | **Eliminations**: `org.rooms`/room members (config); `org.departments` is KEPT as the agent catalog (postId/title/sessionTitle/agentOptions — ensureHead/attach/pin unchanged); `board-store.ts`; the `deepartments/room` projection; `emitRoomRecord` + room relay; room read-deltas in `cursors.json`; rooms wording in presets/personas (cleanup phase, noted here); board docs in the skill. | §7.1 |
| D8 | **Kept intact**: ensureHost/single-live; ensureHead + attach + pinning; posts.json/hosts.json (recipient catalog); dept_memo_write/journals/archive; wakePost + guards (stuck-head, ack-loop); U3 watcher; role-contract injector; **host session rotation** (dept_sleep host branch, spec 002); presets/subagent projection. **wakePost becomes the bus core** — a legacy dormant entry (sleepEpoch on disk) still wakes via direct message, not room delta. (LOTE A 2026-08-27: the head/worker sleep is RETIRED — dept_sleep remains only on the host plane.) | §7.2 |
| D9 | **Migration**: Batch B2 (core, dual-run) then B3 (cleanup/tests/docs); legacy `<stateDir>/rooms/` dirs renamed to `.bak-legacy`; tiered verification per AGENTS.md + headless smoke. | §8 |

---

## 1. Context & Motivation

Today all agent→agent communication in dsh-deepartments goes through the **board**: every
registered agent belongs to a room (`org.rooms`), addressed messages are written via
`dept_room_write` into a per-room `board.jsonl` (`board-store.ts`), a relay watches emitted
room records and wakes addressed members with a "Board delta in <room>…" followup
(`invoke.ts` relay), and members read deltas via `dept_room_read` with per-member cursors.
Phase 1 reactivated the head machinery on a board-only org (`cordis.patch.yml` has one room,
`board`).

The owner's phase-2 goal (repeated verbatim): **eliminate the board and establish direct,
addressed messaging between agents** — a sent message goes straight to the recipient's
turn, not into a shared room the recipient must poll.

Harness facts that shape the design (explore-deep/2026-08-22-agent-messaging-design.md,
citations in `spec_ref`):

1. **The native `send_message` is NOT a base**: it is a thin adapter over
   `ctx.subagents.followup(parent, childId, …)`, whose authority domain is the **exact live
   direct parent of a continuable child** (`authorizeLineage`, dsh-subagent
   `continuation.js:904-911`); cold resume additionally requires a persisted
   `subagent/descriptor` with `mode: 'continuable'` (`continuation.js:637-640`).
   Head sessions are **root agents** (`head-<postId>`, no `subagent/descriptor`) → the native
   tool can never reach a head, a worker, or the host — live or dormant.
2. **There is no general agent→agent bus in the harness.** The complete inventory of delivery
   paths: paren t→child followup, child→live-parent settlement notices, schedule (resident
   only), goal round driver (self), host user prompt (resumes dormant), and the plugin's own
   board relay (raw followup on live/resumed root agents).
3. **The real seam is the pair the plugin already uses**: `ctx.agents.resume({resumeSessionId,
   …})` + `Agent.followup(createUserMessage({content, source}))` — exactly `wakePost`
   (`invoke.ts:4105-4179`; canonical host analogue: dsh-host-apiproxy `ensureSession`
   `1303-1389` + prompt `2077-2137`). Delivery anatomy: `followup` → `inbox.splice('next-turn')`
   → durable `agent/inbox/spliced` event → `wakeDriver` → turn claims at preStep and appends
   `user/message`.
4. **The inbox is durable across resumes but is NOT a history and is cleared at dispose**
   (`AgentLoop` prepare's dispose cancels `{kind:'disposed'}` without `keepInbox` →
   `inbox.clear()`, dsh-agent-loop `405-411`/`1129-1152`) → **never deliver "into a dormant
   agent's inbox": deliver AFTER resume** (wakePost already does).
5. **GUI rendering**: a `user/message` with `source.kind !== 'user'` renders as a **collapsed
   context row** — label = kind, body per form (dsh-client-ui-conversation `client.js:8605-8644`;
   runtime `dsh-client-runtime 10419-10473`). The model sees the full text; the human sees row
   chrome. **`to[]` is never rendered** → recipients and sender MUST be framed in the delivered
   text (§4.3).

---

## 2. Goals & Non-Goals

### Goals (requirements — do NOT re-litigate)

1. **G1 — Kill the board.** Remove rooms from config and code; remove
   `dept_room_write`/`dept_room_read`/`dept_room_who`; remove `board-store.ts`, the
   `deepartments/room` projection, `emitRoomRecord` and the room relay; remove room read-deltas
   from `cursors.json`. The second phase's only "shared space" is the append-only message
   store.
2. **G2 — Direct addressed messaging.** One plugin-owned `send_message(to[], text, {ack?,
   sensitive?, threadId?})` that delivers to catalog members (host + heads/workers from
   hosts.json/posts.json) via the wakePost seam — **always waking the recipient** (D4) — and
   to transient child subagents via the native continuable followup, with the tool deciding the
   route.
3. **G3 — Durable, queryable history.** `<stateDir>/messages.jsonl` is the single source of
   truth for everything ever sent; `agent_messages` pages the caller's own received history in
   O(1) via a boot-built per-recipient seq index (§3.3), not by slicing the global log.
4. **G4 — One identity/roster tool.** `dept_who` replaces both `dept_room_who` and
   `dept_whereami`; an agent learns who exists and who it is in one call.
5. **G5 — Dedicated `send_message` (D2).** Exactly ONE tool named `send_message` per
   deepartments agent. The harness native is disabled via the preset/tool layer; the plugin
   registers its own on the host plane and in head/worker layers (single definition, reused).
6. **G6 — B2 dual-run, then B3 cutover.** The board keeps working alongside the bus in B2
   (comparable smoke, no rollback cliff), then is deleted in B3 together with legacy state
   migration.

### Non-goals (explicitly out of scope for this spec)

- **No read receipts / seen marks** (§5 note): read state, unread counts and a GUI inbox
  view are a later phase.
- **No sleep-request protocol** (LOTE A, 2026-08-27: the head/worker sleep is RETIRED — heads
  stay `idle|running`, no self-directed head sleep; the HOST conserves `dept_sleep`
  (spec 002 rotation); wakePost remains the only wake path for a legacy dormant entry —
  `dept_sleep` host machinery untouched, D8).
- **No context compaction/reset changes** for heads (current semantics: resume of the same
  durable session; the session log is the memory).
- **No change to worker lifecycle** (`dept_post_create`/`dept_post_retire` stays; workers are
  org members, not "members of a room").
- **No GUI change** beyond what the store/RPC repoint requires (the native chat UI already
  renders bus messages as context rows; no custom inbox view is built).
- **No harness modification** — the bus is entirely plugin-owned.

---

## 3. Message store — `<stateDir>/messages.jsonl`

### 3.1 Record shape (exact)

```jsonc
{
  "id": "m-<seq>",            // string id, `m-` prefix + the record's seq
  "seq": 0,                   // global contiguous counter, starts at 0, +1 per record
  "ts": 1724370000000,        // Date.now() at persist
  "from": "research-head",    // member id (postId or hostId) of the sender
  "to": ["asistente", "programming-head"],  // ≥1 member ids
  "text": "...",              // the raw authored text (unframed)
  "kind": "agent",            // 'agent' | 'notice' | 'ack'  (payload typology, see below)
  "threadId": "m-12",         // optional: reply-to for a thread (first message of the thread or a stable parent id)
  "sensitive": false          // optional: sensitive flag (trust semantics carry over from the board)
}
```

- `seq` is **contiguous and global** (the board-store central invariant,
  `board-store.ts:16-23`): append-time counter, seeded from the loaded file's last seq +1 at
  boot (no gaps, no reordering). O(1) append (`seq = nextSeq++`); `id` is derived (`m-<seq>`)
  and unique. Paging is NOT a slice of the global log: a recipient's own records are a sparse
  subset of seqs, so the O(1) page boundary comes from the per-recipient index (§3.3).
- `kind` semantics: `'agent'` = normal agent message; `'notice'` = system/relay notice
  (e.g. sleep-wake notices, wake-pack summaries); `'ack'` = acknowledgement-only records
  (no agent content expected back). The `kind` field drives the GUI context-row label (see
  §4.3 framing) and the wake pack. **Producers in B2**: `send_message` carries NO `kind`
  parameter (schema §4.1) and writes `kind: 'agent'` — or `kind: 'ack'` when `ack: true`;
  no other producer exists in B2; `'notice'` records (relay/sleep-wake notices, wake-pack summaries) are deferred to **B3**.
- `from`/`to` are **member ids** (`postId`/`hostId`, not session ids) so that history stays
  readable and stable across host rotation (`host-<sessionId>` changes per rotation; the
  **host member id stays `host`-family, see §7.2 note** — builder-verify the exact stable
  host agentId convention so `from`/`to` survive rotation).

### 3.2 Persistence — board-store pattern (`board-store.ts:161-396`)

- **Path**: `<stateDir>/messages.jsonl` (single file; the state dir is already the
  plugin's root, resolved like all current stores).
- **Flush (durability contract)**: append = `mkdir` (recursive) + `appendFile` of one
  `JSON.stringify(record)` + `'\n'`, awaited — the record is on disk **before** any delivery
  starts. Single-process assumption (one writer) → no locking, same as the board store.
- **Load**: missing file → empty list; parse tolerant of a **trailing partial line**
  (crash mid-append drops it); a malformed non-final line **throws loud** (mid-file
  corruption) — mirror `parseBoardRecords` (`board-store.ts:171-185`).
- **Compaction (boot-only, rare)** — mirror `compactBoardFile` (`board-store.ts:381-396`):
  triggered at boot when record count > 2000 or raw bytes > 256 KiB (reuse the existing
  thresholds); keep-rule = keep records where `from` ∪ any `to` intersects the **durable
  member ids** (posts.json ∪ hosts.json non-retired — the simplification of
  `durableMemberIds`, `board-store.ts:346-373`); renumber `seq` 0..N-1 and re-id
  `m-<newSeq>`; rewrite the whole file — **and rewrite every `threadId` reference through the
  old→new id map** (a kept record's `threadId` pointing at another kept record must point at
  the record's NEW id; a `threadId` whose target was trimmed becomes `null`); **no runtime
  compact tool** (a mid-process compact cannot reseed projections — by design, same as the
  board). Compaction is defensive only: nothing is trimmed except messages of members no
  longer in the catalog.
- **Backup**: the board store does not back up compacted files; for `messages.jsonl` the
  legacy-room rename (§8.2) is the only guaranteed backup step. ❓ Builder-verify whether a
  pre-compaction `.bak` copy is warranted — recommended: yes, one `messages.jsonl.bak` per
  compaction (cheap, one file).
- **Builder-verify (D3)**: `agent_messages`' `before` cursor is a `m-<seq>` id; after a
  compaction renumbers seqs, old cursor ids may not resolve. Resolution rule: look up the id
  → if missing, clamp to the newest record (history is still valid, the cursor was just
  renumbered); document this in the tool's render text.

### 3.3 Per-recipient seq index (built at boot) — no read cursors in this phase

The paging of `agent_messages` (own history) is powered by a **per-recipient seq index** built
at boot: a map `recipientId → sorted array of own seqs` (one entry per recorded message with
that recipient ∈ to[]; ascending seq, i.e. insertion order, since the file is append-only).
The index admits O(log n) `before`-cursor resolution (binary search) and O(1) page reads
(array slice) — and, critically, a **correct `remaining` count**: `index.length -
(pageStartIndex + pageLen)`, i.e. exactly the own records older than the page, no matter how
sparse the own seqs are within the global seq. (A naive `total - (seqLo + pageLen)` is
wrong: own records are a sparse subset of the global seq.) ❓ Builder-verify the index's
memory shape (per-member arrays vs a single `{to[], seq}` array sorted by seq; both
acceptable).

`cursors.json` (member read-delta for rooms) is **not** repurposed per-recipient: read state
is a different concern from paging indexes, so no read state file is needed. `cursors.json` is
either deleted outright or left empty after B3 (see §8.2). Per-recipient read/seen state is
deferred with §5.

---

## 4. Tool `send_message` (plugin-owned, one tool)

### 4.1 Identity & registration (D2)

- **Name**: `send_message` — final, single. Registered: (a) on the host plane (host session),
  (b) in the head/worker own layer (`installHeadBoardTools`-style reuse — the SAME tool body
  registered in each layer, as today's board tools).
- **The harness native `send_message` (dsh-tool-subagent-control) is DISABLED** for every
  deepartments agent so exactly one tool of that name is visible. ❓ Builder-verify the exact
  seam (candidate: preset-level `toolFilter.deny` on the global-layer tool, or a per-layer
  override in the plugin's setup) — the plugin has precedent for lean `toolFilter`
  (`org.ts:20`, `invoke.ts:3723`, `subagent.ts`).
- **Schema** (AGENTS.md rule 3 — `defineTool`, flat `parameters` with `required: true`,
  mandatory `output.{schema,render}`):
  - `to: string[]` (required, min 1, max 20 — the fan-out cap, §4.4)
  - `text: string` (required)
  - `ack?: boolean` (optional)
  - `sensitive?: boolean` (optional)
  - `threadId?: string` (optional; a message id to reply to)
  - output schema: `{ messageId: string, delivered: { <agentId>: 'delivered'|'resumed'|'failed'|'self' } }`;
    render: one line per recipient with the outcome, or a single line when all delivered.

### 4.2 Recipient resolution & catalog

- **Route resolution order (per recipient, evaluated BEFORE anything is persisted)**:
  (1) **child route first** — if the caller is the **direct parent** of a transient
  (`subagent`-dispatched, continuable) child with that agentId, the recipient is a child
  target and is delivered via the native continuable followup (§4.3 step 4) — it is NEVER
  validated against the catalog; (2) otherwise **catalog** = posts.json (heads/workers) ∪
  hosts.json (non-retired host entries) — the durable recipient registry, unchanged from today
  (`isKnownAddressee` generalized, `invoke.ts:2078-2104`). Every catalog-route recipient id is
  validated against the catalog; unknown ids are not a hard error — they become
  `failed: 'unknown'` per recipient so one typo does not kill a multi-recipient send.
  (Consequence: a transient child agentId can never fall into `failed: 'unknown'` — the child
  route is decided first.)
- **Target resolution**: `sessionId` from the registry entry (post → `head-<postId>` /
  `worker-<postId>-<uuid>` (id único por encarnación, como los heads F8); host → the live/registered host session id); `sleepEpoch` from the
  entry; live status from the AgentRegistry.
- **Child targets (the route resolved first above)**: its delivery is the **native
  continuable followup** (`ctx.subagents.followup` — running → inbox enqueue, ready → cold
  resume). The tool decides the route itself; the caller passes the same agentId, no special
  syntax. (This preserves the Asistente's ability to steer its active builders while also
  addressing catalog members.)

### 4.3 Delivery — the wakePost pattern, exactly (D4)

For each recipient, IN ORDER (serialized per message, §4.4):

1. **Persist first (durable)**: append the record to `messages.jsonl` (one record per send
   call, `to[]` = all recipients) — the record is on disk before any delivery; it is the
   re-delivery source. Then, per recipient, write the delivery-intent row (pending →
   delivered/failed) — §4.4 idempotency.
2. **Seam (catalog targets)** — EXACTLY `wakePost` (`invoke.ts:4105-4179`):
   - live + sane target → `markHeadProgress` + `target.followup(createUserMessage({content,
     source}))`;
   - not live or `sleepEpoch` set → dispose the stale handle, clear `sleepEpoch` (keeping
     `previousChildId`), `ctx.agents.resume({resumeSessionId})` (fallback `agents.create`)
     with the durable per-head preset (`entry.agentPreset`) and `setup = headSetup(...)`,
     THEN `target.followup(...)`;
   - live-but-stuck target (`isHeadStuck`, `markHeadProgress`, `serializeHeadRecovery` —
     `invoke.ts:4060-4094`/`1394-1407`) → dispose + cold resume (serialized).
   **The recipient is ALWAYS woken — including the host** (D4): no skip-and-log branch for a
   headless/rotated host session; a non-live host session is resumed exactly like a dormant
   head (the owner accepted the materialized host turn).
   - `source`: `{ kind: 'agent', form: 'send', senderSessionId }` (the MessageSource map is
     open; `invoke.ts:190-194`). ❓ Builder-verify whether `to` is also carried on the source
     (recommended: yes — additive, and it makes the GUI row bodyable); the model-facing
     framing below is authoritative regardless.
3. **Framing (the model-facing text)** — the delivered content is:

   ```
   [From <senderId> → <to1>, <to2>, …]: <text>
   ```

   Because the GUI renders `source.kind !== 'user'` messages as a collapsed context row with
   label = `kind` and **never renders `to[]`** (`client.js:8605-8644`), sender + recipients
   MUST live in the delivered text. The row's summary line (human-visible chrome) must be
   informative: `"New message from <senderId> to <n> recipient(s) (<kind>)"`. The plugin's
   own `form: 'send'` (new form in the source map, mirroring `form: 'notice'`/`'relay'`)
   drives the body renderer; ❓ builder-verify the client-side fallback for unknown forms
   (it must degrade to showing the framed text — never hide it).
4. **Child targets**: `ctx.subagents.followup(parent, childId, [{type:'text', text:
   framed}], { source: { kind: 'agent', form: 'send', senderSessionId }, signal })` — same
   framing so the child sees sender + recipients.

**Result**: `{ messageId, delivered: { <recipientId>: 'delivered'|'resumed'|'failed'|'self' } }`
— `'delivered'` = followup accepted by a live agent; `'resumed'` = the agent was woken from
dormant (resume + followup); `'failed'` = resume/serialization fallback failed (the error is
logged AND returned in the tool's render text — never silent); `'self'` = the recipient is the
caller itself — the record is persisted but no wake/delivery occurs (§4.4 ack-loop guard). A
failed recipient keeps its record (store is durable); re-delivery is a later `send` with the
same `threadId` or a delivery retry (§4.4).

### 4.4 Guards (carried over from the relay, unchanged in spirit)

- **Fan-out cap**: `to[]` ≤ 20 recipients (hard error above; the tool schema enforces max on
  the array).
- **Per-message serialization**: deliveries for one message run one-at-a-time (never parallel
  resume of N dormant agents — quota + race safety; the existing `serialize` pattern,
  `invoke.ts:2014-2019`).
- **Ack-loop guard**: no delivery re-enters the caller's own turn. A self-addressed send
  (caller ∈ to[]) is persisted and returned as `delivered[self] = 'self'` (held, no wake) — it
  must never trigger a followup into the sending agent's own turn (the relay's ack-loop guard
  spirit, `invoke.ts:2094-2107`).
- **Stuck-head recovery verbatim**: `isHeadStuck`/`markHeadProgress`/
  `serializeHeadRecovery` move into the bus deliver loop unchanged.
- **Idempotent re-delivery (D4)**: the store record is the durable source; delivery state is
  tracked per `(messageId, recipientId)` via a write-ahead append-only sidecar
  `deliveries.jsonl` (rows: `pending` → `delivered`/`failed`, one row per transition), so a
  crash between persist and delivery (or mid-fan-out) lets boot re-run only the `pending`
  rows — never double-deliver a `delivered` one. ❓ Builder-verify the exact sidecar shape
  and the sidecar's own boot compaction (keep only the latest state per key). Alternative the
  implementer may choose (equivalent guarantee): a `delivered: true`-style marker updated
  in-place is NOT allowed on an append-only store — the write-ahead sidecar is the wanted
  pattern.

---

## 5. Tool `agent_messages` (own history)

- **Semantics**: return the caller's OWN received history — records where the caller's
  member id ∈ `to[]` (regardless of `from`). No room filter, no shared-read mode (the board
  is dead).
- **Parameters**: `limit` (optional, default 10, max 50); `before` (optional, message id
  `m-<seq>` — exclusive cursor on `seq`; O(1) page boundary via the per-recipient index
  §3.3; §3.2 clamp rule after compaction). No `offset` (the cursor is the stable paging shape
  for a growing append-only log).
- **Response**: `{ total, messages, remaining }` — `total` = count of the caller's own
  records in store; `messages` = page, **most-recent-first** (descending seq); `remaining`
  = count of own records with seq below the page's minimum seq, computed from the
  per-recipient seq index (§3.3): `index.length - (pageStartIndex + pageLen)` — NOT
  `total - (seqLo + pageLen)`, which is meaningless because own seqs are a sparse subset of
  the global seq; each message: `{ id, ts, from, to, text, kind, threadId?, sensitive? }`.
- **Registration**: host plane + head/worker own layer (single definition, like
  `send_message`).
- **NOTE (phase note, keep in code comment + tool description)**: there are NO read/seen
  marks in this phase — `agent_messages` is a pure history pager; "new/unread" semantics,
  per-recipient read state, per-recipient cursors file and the unread badge (today derived
  from board records in `agents.ts` — repoint or kill, §7.1) are a later phase whose source
  of truth will be this store.

---

## 6. Tool `dept_who` (fusion) + identity

- **One tool, no parameters** — replaces `dept_room_who` AND `dept_whereami`. `dept_whereami`
  is **deleted** (both host-plane and own-layer definitions).
- **Output**: the WHOLE catalog, one entry per registered member:
  `{ agentId, kind: 'host'|'head', title, live: boolean, sleeping: boolean, sessionId? }`.
  - `agentId` = member id (postId / host agentId); `kind` = `'host'` for the hosts.json host
    entry, `'head'` for posts;
  - title = `org.departments[].coordinator.title` for department heads; `PostEntry.role`
    fallback for worker posts; `'Asistente'` for the host — **source note**: the persisted
    registries carry no title (`PostEntryPersisted` invoke.ts:300-309, `HostEntry`
    invoke.ts:312-363);
  - `live` = AgentRegistry has the session; `sleeping` = `sleepEpoch` set / disposed
    (registered but not materialized);
  - `sessionId` = the registry session id (`head-<postId>`, host session id) when known.
  - **`you: true` marks the CALLING agent's entry** — an agent reads its own identity
    (agentId, kind, title) from this tool; the plugin no longer needs a separate identity
    tool. (The old `dept_whereami` "post vs host" shape dies with the room notion; the
    host/post split is now just `kind`.)
- **No `room` parameter ever**; the roster is the org. Note for builders: worker-only posts
  (created via `dept_post_create`) are catalog members; ❓ builder-verify whether they render
  as `kind: 'head'` or are omitted until a third kind exists (recommended: list them with
  `kind: 'head'` — they can be addressed).
- The host wake pack's roster section (`buildCondensedRoster`) reuses the same catalog
  enumeration (§7.2).

---

## 7. Eliminations & kept pieces

### 7.1 Eliminated (B2 core + B3 cleanup — the deletions land in B3, see §8.1)

| Piece | Location | Notes |
|---|---|---|
| `org.rooms` + room members + `RoomConfig.roomId` | org.ts:42-71, 83-92, 103-126 | rooms die |
| Room session creation at boot (`applyOrg`), `roomSessionId`, `resolveRoomSession` | org.ts:383-445, 536-621 | board-only |
| `deepartments/room` projection + fold | org.ts:148-377 | board-only |
| `emitRoomRecord` + board-record listeners + **the relay** | org.ts:465-528; invoke.ts:4187-4340 | relay logic is ABSORBED by the bus delivery (§4.3-4.4: recipient resolution, always-wake, stuck-head, ack-loop guards) |
| `board-store.ts` (whole module) | board-store.ts:161-396 | superseded by `messages.jsonl` (§3; the parse/append/compact patterns are copied, not imported) |
| `memberCursors` / `persistedCursors` / room read-delta in `cursors.json` | invoke.ts:1408, 1632-1652, 1982-2010, 4344-4362 | cursors.json stays empty or is deleted (§3.3, §8.2) |
| `emitBoardMessage` / `seedNextSeq` / `nextSeq` / `roomQueues` / `serialize` (room flavor) | invoke.ts:1442-1450, 2012-2075 | superseded by the store + per-message serialization |
| `dept_room_write` / `dept_room_read` (host + own layer) | invoke.ts:4374-4497 / 3134-… | deleted |
| `dept_room_who` / `dept_whereami` | invoke.ts:4499-4751 / 3130-… | replaced by `dept_who` (§6) |
| `dept_wake_snapshot` board-delta inputs | invoke.ts:2893-2984, 4722-4751 | inputs become message-delta (latest-received… see §7.2) + roster |
| Rooms wording in presets/personas | presets/deepartments-head/agent.cordis.yml:5,41; presets/deepartments-worker/agent.cordis.yml:7; `installRoleSection` ("of the X department room") | **cleanup-phase note**: persona prose rewritten in B3 (B2 may keep wording while dual-running) |
| Board protocol docs | docs/specs/*, docs/IDEA.md, docs/concept.md, docs/ROADMAP.md, `.dsh/skills/deepartments-workflow/SKILL.md` | updated in B3; this spec supersedes the board protocol |
| Board test fixtures | test/invoke.test.js (+ friends) | rewritten to messaging fixtures in B3 (~189 tests blast radius, §8.4) |
| `/deepartments/agents` unread derivation (`unreadFor`) + RPC usage | agents.ts:89-169, invoke.ts:5052-5186 | repoint to `messages.jsonl` counts or kill — §5 note |

### 7.2 Kept intact (do NOT touch in B2/B3 unless the bus needs a seam)

- `ensureHost` (single-live-host guard, refresh-merge, title pin) — invoke.ts:1525-1592; and
  `hostIdForSession`/`hosts`/`persistHosts` (1459-1494, 1596).
- `ensureHead`/`ensureAllHeads` (idempotent create/resume, per-head preset, handle registry)
  + `headSetup`/`workerSetup`/`postSetup` + `attachHeadSession` + `disposeHeadHandle` +
  **pinning** — invoke.ts:3690-3768, 3905-4016, 4030-4058.
- `org.departments` **as the agent catalog** (postId/title/sessionTitle/agentOptions) — the
  only input to materialize heads; `roomId` fields drop out, everything else stays.
  ❓ Builder-verify the exact config schema relaxation (old `coordinator.role`/`provider`
  fold into `title`/`agentOptions` where redundant; `sessionTitle` = the title pin for the
  native sidebar row, host-pin analogue `pinHostSessionTitle`).
- `posts.json`/`hosts.json` (recipient catalog), `byPost`/`byChild`/`registerEntry`/
  `persistPosts`/`PostEntry` — kept; `roomId` falls back removed (or defaulted).
- `dept_memo_write`, journals + archive +
  session-log capture — the `room:` frontmatter field becomes informational-only (default
  kept; no behavior). (`dept_sleep` head branch + host rotation were "kept intact" pre-LOTE-A;
  **2026-08-27 (LOTE A)**: the head branch is RETIRED (heads/workers stay idle|running);
  the HOST branch — session rotation, spec 002 — stays.)
- **wakePost + its guards — now the bus core** (D8): sleep-wake of heads happens by direct
  message (bus delivery), not by room delta; `wakePost`'s body becomes the shared deliver
  helper used by `send_message`. Stuck-head recovery, ack-loop guard, serialization all live
  here.
- U3 watcher (client/index.tsx:31-180 — host/status RPC, 5s), role-contract injector
  (subagent role orientation), host session rotation (session-rotation.ts +
  session-cleanup.ts), presets/subagent projection (`head-presets.ts`, `subagent.ts`,
  `role-orient.ts`).
- `installRoleSection` (head role text) — **minus the room references** (wording in B3).
- `dept_post_create`/`dept_post_retire` — worker lifecycle unchanged; worker = org member.
- **Wake pack**: host wake pack keeps roster; the board-delta section becomes a
  **message-delta** section — the caller's **latest-received** messages from the store
  (capped N, newest-first; no unread/read state — D5), as the injected context — the analog
  of today's board delta. ❓ Builder-verify exact pack section shape; keep it small (the pack
  is injected every turn).

---

## 8. Migration & delivery plan

### 8.1 Phases

- **B2 — core (dual-run)**: `messages.jsonl` store + `send_message` + `agent_messages` +
  `dept_who`; delivery via the wakePost seam (D4) incl. guards; recipients catalog plumbing;
  schema relaxation of `org.departments`; `dept_whereami` deleted and `dept_who` registered.
  The board KEEPS working (room tools still present) so the tiered smoke compares both paths
  and nothing breaks mid-flight. Headless smoke drives: `dept_who` → `send_message` → the
  recipient `agent_messages` shows it (both live and dormant-head targets).
- **B3 — cleanup / tests / docs**: delete every §7.1 board piece; persona/preset wording;
  board docs in the skill updated to the messaging protocol; test fixtures rewritten; state
  migration (§8.2).

### 8.2 State migration (B3)

- `<stateDir>/rooms/` is **renamed to `<stateDir>/rooms.bak-legacy-<YYYYMMDD>/`** (move, not
  delete — the legacy board.jsonl history stays as evidence; equally
  `rooms.bak-legacy-20260822` leftovers consolidate under the one legacy dir, see
  head-machinery report §1).
- `cursors.json`: room-delta keys dropped; the file is either emptied or deleted (§3.3).
- Old durable artifacts in the harness sessions store (`deepartments-room-*`,
  legacy `head-*`) are LEFT INERT (no deletion — they are just not referenced); optional
  later sweep, not part of this spec.
- `messages.jsonl` starts EMPTY at cutover: the board history is legacy, preserved in the
  `.bak-legacy` dir; nothing is imported (a future "archive import" is out of scope).

### 8.3 Verification

Per AGENTS.md tiered verification, both phases:

1. `pnpm build` (tsc NodeNext, no type errors).
2. `DSH_HOME=/opt/dsh/.dsh-dev dsh plugin --profile deepartments-dev add
   /home/esuarez/projects/deepartments` (restart required after add).
3. `DSH_HOME=/opt/dsh/.dsh-dev dsh --profile deepartments-dev --dump-config` — must show the
   `# == dsh-deepartments` layer, and — after B3 — NO `rooms` section.
4. Headless smoke in `deepartments-dev-headless`: boot with a departments config →
   `dept_who` lists host + heads with `you: true` on self → `send_message` to a live head
   returns `delivered` and the target's `agent_messages` shows it → a (legacy)
   dormant head wakes with `resumed` on `send_message` → fan-out to 21 recipients is rejected
   → self-send is held (`self`). (Head `dept_sleep` is RETIRED — LOTE A 2026-08-27; the host
   rotation keeps `dept_sleep`, spec 002.)

### 8.4 Risks

1. **Model quota** (D4 always-wake): every `send_message` to a dormant agent materializes a
   full produced turn (resume + followup). Mitigations: fan-out cap 20, serialized delivery,
   threadId grouping; the owner accepted materializing a host turn even without an open tab
   (the U3 watcher keeps the UI in sync; a headless-host resume just produces a turn).
2. **GUI context-row visibility**: the recipient sees sender + `to[]` only via the framed
   text and the summary chrome (the client never renders `to[]`); a too-terse summary makes
   messages opaque to the HUMAN. Mitigation: required informative summary + framed body
   (§4.3); verify in the GUI profile during B2.
3. **Fan-out blast**: N recipients = N follows = N turns; serialized delivery lengthens a
   large fan-out; cap + per-recipient failure reporting keeps one bad recipient from killing
   the message.
4. **Test blast radius**: ~189 tests + docs/specs + skill + presets prose cover board flows;
   B3 is a big mechanical rewrite — plan fixtures first (messaging happy path, guards,
   paging, compaction, dept_who fusion), then delete board fixtures in the same batch.
5. **Inbox cleared at dispose** → never deliver before resume; the bus follows wakePost
   (deliver AFTER resume), and the store is the durable source (write-ahead sidecar §4.4) so a
   crash between persist and delivery only re-runs pending rows.
6. **`send_message` ambiguity**: with the native tool disabled (D2), the plugin tool must be
   reachable everywhere deepartments agents run (host preset + head/worker layers); a missed
   registration would leave an agent with a dead tool or (worse) the native one. B2's smoke
   must assert exactly one `send_message` per agent.
7. **Roster drift (kinds/titles)**: `dept_who` title/kind come from the registries; after
   host rotation the host entry's agentId must stay stable (§3.1 note) or history
   `from`/`to` break — verify across a rotation.

---

## 9. Decisions + builder-verify points

### Resolved (baked in — do NOT re-litigate)

- **D1-D9** in §0: board deleted; one plugin `send_message` (native disabled, D2);
  `messages.jsonl` record shape/path (D3); always-wake + persist-before-deliver + idempotent
  re-delivery (D4); `agent_messages` pager, no read marks this phase (D5); `dept_who` fusion,
  `dept_whereami` deleted (D6); eliminations + keep-list (D7/D8); B2/B3 migration (D9).

### Builder-verify points (❓ — implementation detail, not owner questions)

- Exact seam disabling the native `send_message` (preset `toolFilter.deny` vs layer
  precedence) (§4.1).
- Host stable agentId convention across rotation (§3.1) so `from`/`to` stay valid.
- Pre-compaction `.bak` copy of `messages.jsonl`; `before`-cursor clamp after renumbering
  (§3.2).
- Whether `to` rides on the delivered `source` in addition to the framed text; client
  fallback renderer for `form: 'send'` (§4.3).
- Write-ahead `deliveries.jsonl` sidecar shape + its compaction (§4.4).
- `dept_who`: worker-only posts (`kind: 'head'` vs omitted) (§6).
- `org.departments` schema relaxation (role/provider fold; sessionTitle pin) (§7.2).
- Wake-pack message-delta section shape + size cap (§7.2).
- Test-count baseline before/after B3 (target: full suite green; board fixtures replaced, not
  merely deleted) (§8.4).

---

## PATTERNS / INVARIANTS / SURPRISES (for the builders)

- **Invariants kept**: durable-before-deliver (the record is the source of truth); deliver
  AFTER resume (never into a pre-resume inbox — dispose clears it); one writer (single
  process, no locking); `seq` contiguous global, `id = m-<n>`; per-message serialized
  delivery; ack-loop guard (self-send held, never re-enters own turn); fan-out cap 20;
  stuck-head recovery verbatim; heads stay root agents (`head-<postId>`, no
  subagent/descriptor — the native followup can never reach them, only the plugin bus can);
  no runtime compact tool; tool registration rules of AGENTS.md (defineTool, flat required
  params, output schema+render).
- **Surprises verified by exploration**: (1) the native `send_message` is parent→continuable-
  child ONLY (`continuation.js:904-911`, `637-640`) — useless as a bus base; (2) the inbox
  survives resumes but is erased at dispose (`agent-loop 405-411`, `1129-1152`); (3) the GUI
  renders non-`user` messages as collapsed context rows and never renders `to[]`
  (`client.js:8605-8644`) — frame the recipients in the text; (4) `wakePost` (invoke.ts:
  4105-4179) is ALREADY room-free and IS the bus deliverer; (5) the relay's guards (ack-loop,
  empty-delta, stuck-head) are absorbed, not reinvented; (6) sleep-wake of heads was always
  message-addressed ("Board delta…") — the bus only changes the framing and the store.
- **Primary source line refs for builders**: explore-deep/2026-08-22-agent-messaging-design.md
  §1 (native tool anatomy: `dsh-tool-subagent-control lib/index.js:20-66`,
  `continuation.js:236-262/619-663/847-911`), §1.4 (inbox durability/dispose),
  §1.5 (`followup`/`steer`/`inject` table), §2.1-2.2 (keep/kill inventory),
  §3.1-3.2 (store + tools sketch), §4 (risks, incl. the always-wake policy discussion that
  D4 overrides), §5 (full file:line index); explore-deep/2026-08-22-head-machinery.md §2-6
  (head preset/posts/cycles/sidebar facts); board-store.ts:161-396 (parse/append/compact/cursor
  pattern to mirror); 002-host-session-rotation.md (this spec's format).
