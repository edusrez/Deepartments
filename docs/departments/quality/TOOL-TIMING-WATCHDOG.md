# QD — Tool-timing watchdog (surveillance norm)

**Status: DURABLE NORM — mandatory in every QD inspection round.**
Source: owner directive relayed by the Asistente host in a QUALITY REQUEST
(2026-09-10, host `host-session-496fa3fc-5aa4-4b9d-a5f9-669b01ed9de0`), plus the
QD's own process read. This file is the **canonical home of the norm**; the
inspector persona (`presets/departments/quality/quality-inspector.md`), the
department `ARCHITECTURE.md` and the `quality-daily` job **point here**, they do
not restate it.

> A tool call is not just a call: it is a **duration**. Today the org measures
> whether a tool SUCCEEDED; it never measures whether it took 0,3 s or 4 min.
> The slowest calls are invisible precisely because they succeed.

## 1. What every inspector round must measure

Per round, over the round's declared window, include a **tool-timing table**:

| column | meaning |
|---|---|
| tool | tool name (`intent.tool` / the call's name) |
| n | paired calls in the window (intent matched to its settle) |
| p50 / p95 / max | durations in seconds |
| outliers | every call above the anomaly criterion, **with the calling agent, the recipient (when the tool has one) and the message id** |

Minimum tool coverage — the four that carry the org (extend as evidence demands):

- **`send_message`** — the one that carries the defect of the day: bimodal with a
  minutes-long tail.
- **`dept_feedback`** — instant except for a 2-3 min tail (hypothesis, to be
  confirmed or dropped: the **notify-QD leg**, which is severity-gated).
- **`dept_worker_spawn`** — the silent-degradation class (`fb-29`: an
  interrupted spawn that still materialises a worker with a degraded toolset).
- **`dept_exec`** — the long tail of legitimate shell work (`zstd -dc`, tests,
  walks) is the baseline that makes the others interpretable.

## 2. Declared anomaly criterion (owner-proposed, adopted by the QD)

A tool's timing is **ANOMALOUS** when either holds in the window:

- **`max > 60 s`**, or
- **`p95 > 5 × p50`** (bimodality: the tail is not the same population as the
  body).

Both must be reported per tool, with the OUTLIER CALLS enumerated (agent +
recipient + message id). A criterion that fires with no named outliers is not a
finding. When a criterion is **not** met, say so — the absence of a tail is
itself a datapoint (today's `dept_worker_spawn` p50 18,0 s / p95 104,5 s is a
2nd-order case: criterion met by `max`, not by bimodality).

## 3. Method (deterministic, reproducible — the number is a PHOTO)

Source: **`<stateDir>/tool-intents.jsonl`** (`stateDir = /.deepartments`), which
carries an `intent` line and a `settle` line per call. Duration = `settle.ts −
intent.ts`, paired by **`id`** (never by order or by timestamps alone).

Rules, inherited from the drain-metric discipline (fb-137/fb-352 — never cite a
number without its instant and its population):

1. **Declare the window and the cut instant** with the command that produced the
   number. Counts change; a duration table without a cut is not evidence.
2. **Pair by `id`; count UNPAIRED intents as their own number.** An intent with
   no settle is not "0 s" — it is a call whose end is unknown (and possibly a
   call still in flight on a live turn). Report it as `unpaired: n`.
3. **Population first**: n per tool, and the tool mix of the window. p95 over
   n<20 is an anecdote, not a percentile — label it as such.
4. **No toolset assumptions**: a tool may be absent from a worker's effective
   set; absence of calls is not absence of the tool (`posts.json` `tools[]` has
   been measured to lie — `builder-250` ran 136 successful `edit` while the
   registry declared none: see `fb-29`).

Recipe skeleton (Node, no deps; the same shape the host's baseline used —
3.365 paired calls):

```bash
node -e '
const fs=require("fs"),L=fs.readFileSync("/.deepartments/tool-intents.jsonl","utf8").trim().split("\n").map(JSON.parse);
const it=new Map(),se=new Map();
for(const r of L){const k=r.id; if(!k)continue;
  if(r.phase==="intent"||r.kind==="intent") it.set(k,r); else if(r.phase==="settle"||r.kind==="settle") se.set(k,r);}
const by={};let unpaired=0;
for(const [k,i] of it) {const s=se.get(k); if(!s){unpaired++;continue;}
  const d=(s.ts-i.ts)/1000, t=i.tool||i.name||"?"; (by[t]??=[]).push({d,id:k,agent:i.agentId||i.from,to:(i.to||[]).join(",")});}
const q=(a,p)=>a.length?a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(p*a.length))]:null;
for(const [t,v] of Object.entries(by).sort((a,b)=>b[1].length-a[1].length)){const d=v.map(x=>x.d);
  console.log(t,"n="+d.length,"p50="+q(d,.5).toFixed(2),"p95="+q(d,.95).toFixed(2),"max="+Math.max(...d).toFixed(2),
   "outliers="+v.filter(x=>x.d>60).map(x=>`${x.id}@${x.agent}->${x.to}:${x.d.toFixed(1)}s`).join(" | "));}
console.log("unpaired intents:",unpaired);'
```

**Status of this recipe: DECLARED, NOT YET EXECUTED BY THE QD** — it is validated
by the first inspector round that runs it; the inspecting round reports both the
numbers and whether the recipe needed correction (the host's baseline numbers in
§5 were measured with the same intent↔settle pairing, so a 2× discrepancy means
the recipe, not the host, is wrong).

## 4. Correlation with the delivery ledger (the process read)

For `send_message` outliers, **cross-check `deliveries.jsonl`**: does the slow
call match a `prepared` row **held** for the same `(messageId, recipientId)`
pair? A slow return that coincides with a held pair is the delivery defect
measured **at the emitter** — the tool's return waits for the settle/wake of the
delivery. Rules for the cross-check:

- read the pair's history, not a single row (the G2 flip rewrites rows in place
  keeping `ts`; the subject is the observable history of the pair);
- `terminal` is NOT a synonym for consumed;
- a `noWake` delivery that drains at the recipient's next wake is **latency, not
  loss** (measured: every `ack:true` to a live host travels without wake by
  construction — `fb-58`);
- report the **pair ids, not message bodies** (fb-16: never reproduce content).

## 5. Baseline on record (host, 2026-09-10 — 3.365 paired calls)

| tool | p50 | p95 | max |
|---|---|---|---|
| `dept_worker_spawn` | 18,0 s | 104,5 s | 184 s |
| `send_message` | 12,1 s | 114,9 s | 234,8 s |
| `dept_memo_write` | 1,3 s | 11,7 s | 51,0 s |
| `dept_exec` | 0,37 s | 12,0 s | 120,2 s |
| `bash` | 0,31 s | 20,5 s | 300,5 s |
| `dept_feedback` | 0,30 s | 129,1 s | 163,4 s |

This table is the **PRE-NORM reference**, not a target: it is a single window
with no per-agent breakdown. Future rounds compare against it **with their own
window declared**, and a regression claim needs the window + population, never
the bare percentile (fb-137 lesson: no number without its instant).
