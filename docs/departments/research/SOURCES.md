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

### CONCURRENT EXTENSION — the same item CAN reach two workers at once
**(head's rule, 2026-09-17; measured, and it survived on luck, not on mechanism)**

**The monitor dispatches the SAME item to MORE THAN ONE worker, and they write
the SAME archive file.** Measured on 2026-09-17: one item (MLPerf v6.1) produced
**six dispatches**, and two of them went **to the same worker** (Δ5.2 s and
Δ35.1 s apart) — so two workers on one topic is a NORMAL case, not an anomaly.
This is not a worker error: the monitor de-duplicates by **emission id**, not by
item identity (an item re-emitted with new wording is a new event).

**Why that is dangerous HERE and not elsewhere:** the researcher toolset has NO
`edit` (deliberate, fb-63/66), so EXTEND = **FULL REWRITE via `write`**. Two
workers doing a full rewrite of one file is **LAST-WRITE-WINS: the loser's
section disappears SILENTLY** — no error, no conflict, no trace.

**The rule — four steps, and they are cheap:**

1. **RE-READ the entry IMMEDIATELY BEFORE the `write`**, not only at the start of
   the round. A read taken minutes earlier is a stale base.
2. **ADD a section; NEVER rewrite the whole entry.** Append your own clearly
   delimited block (`## [N] …`) and carry the existing content forward verbatim.
3. **STAMP your section with your run token** (e.g. `run token d90c7ef9`) and with
   whose content it extends. A section that is lost or superseded must be
   **attributable** afterwards — otherwise a later reader cannot tell whether
   material was never found, or found and clobbered.
4. **If the file changed between your read and your write, RECOMPOSE on the FRESH
   content** — never write your stale copy over it. Losing your own delta costs a
   round; overwriting a sibling's costs THEIR round too.

**★ Control (this worked, and it is the model to copy):** `sources/nvidia-deepseek-v41-flash-nvfp4.md`
— worker `5f9bdaba` filed §[1]–§[6], then worker `d90c7ef9` reached the same
verdict by an independent path and **appended §[7]** carrying five things the
first lacked. Both sections survived intact and both workers' claims agree. **The
same pattern was applied the same day on the Jev companion entry (§6 curator
correction + §7 fourth-pass additions).**
**⚠️ BUT BE HONEST ABOUT WHY IT WORKED: it worked because the two writes happened
to be ORDERED (one read after the other wrote). Nothing in the tool enforced it.
The four steps above are what turns that luck into a mechanism.**

**Note on the duplicate DEPLOYMENT itself:** de-duplicating the monitor's
re-dispatch is **not the department's layer** (it lives in the monitor/daemon
config) — it is escalated, filed as `fb-1837` → folded into canonical `fb-1713`.
What IS the department's layer is the four steps above: they make a duplicate
dispatch **harmless** instead of destructive.

## Archival scope by job (head standing policy, 2026-09-16)

**Not every job archives.** The researcher persona's archive step is the
GENERIC protocol; a job's body is the CONCRETE assignment and wins where they
differ:

- **`monitor-dsh-updates` — does NOT archive to `sources/`.** A daily round that
  most days finds delta ZERO must not add a KB entry per round, or the archive
  fills with near-duplicate topic files, which the "never duplicate" rule
  forbids. Keep every citation in the REPORT; raise a genuinely NEW durable
  topic to the head, who decides.
- **`daily-ai-news` — DOES archive** (this job carries explicit archive steps):
  extend an existing topic file, or create one for a genuinely new topic.
- **The monitor jobs (`deepseek-dsh-news`, `ai-industry-news`) DO archive** — and
  they are the ones subject to the CONCURRENT case above, because the monitor can
  dispatch the same item to two workers. Follow the four steps.

This clause resolves a job-vs-persona conflict that had been re-asked for three
rounds; it is delivered through the head's memo, which both jobs read at the
start of every round.

## web_fetch domain reliability (press releases / news mirrors)

The knowledge-base class **domain → status → fallback** (fb-24): wire and
news-mirror domains behave differently from the datacenter IP of this
deployment's `web_fetch`. Verified datapoints from research rounds
(fb-96/97/98/102/103/104, 2026-09-03): a full fetch on a blocked/unreliable
domain burns the 30 s tool budget every round — consult this table BEFORE
fetching a press release, never after. Updated 2026-09-08 (fb-211 + fb-236,
dictamen QH aceptado: openai.com + aireleasetracker.com + es.dataconomy.com +
pricepertoken.com/model-releases). Updated 2026-09-09 (fb-286 + fb-297,
dictámenes QH aceptados: media.defense.gov + ainvest.com + regla de
presupuesto para dominios 403). **Updated 2026-09-10** (fb-329 + fb-330 + fb-333
+ fb-334 + fb-370 + fb-410, dictámenes QH aceptados: `linux.do`,
`status.opencode.ai`, `www.investing.com`, `reuters.com`, `reddit.com/.json`,
`www.googblogs.com` + la **taxonomía de clase 403-vs-401/captcha**).
**Updated 2026-09-16** (fb-334 + fb-843, edición documental RD: 6 filas nuevas —
`mp.weixin.qq.com`, `huxiu.com`, `techtarget.com`, `4sysops.com`,
`anadolu.agency`/`www.aa.com.tr`, `servicenow.github.io/eva`). **Updated
2026-09-16 (2ª edición)** (fb-1527 → PLEGADA al canónico **fb-177** por dictamen
QH: cuarta clase de fallo + `36kr.com` + el negativo del feed de modelos de HF
+ la regla de «mismo dominio registrable» en la propuesta de arreglo).
**Updated 2026-09-17** (fb-1779 → PLEGADA al canónico vivo **fb-442** por
dictamen QH — «un dominio bloqueado que no tiene fila en la tabla»; edición
documental RD, curación del head: **2 filas nuevas**, una NEGATIVA y una
POSITIVA — `www.axios.com` = 403 anti-bot, y **`alignment.openai.com`** =
fila POSITIVA: subdominio del MISMO publicador cuyo apex está bloqueado).

**Budget rule for 403 anti-bot domains (fb-286, 2026-09-09):** ONE attempt max
per domain per round — a single HTTP 403 confirms the state and exhausts the
attempt; never retry the same domain in the same round (a delivery like a gov
CSA advisory is not fetch-able from this IP). Capture via search-provider
snippets + dated secondaries instead.

**Failure-class taxonomy (fb-334, 2026-09-10 — no son la misma clase):**
**403 anti-bot plano** (tmcnet, zexprwire, openai.com, ainvest, media.defense,
investing.com, linux.do, googblogs.com) → no reintentar, snippet/mirror;
**401 + captcha challenge (DataDome)** (reuters.com) → perfil de fallo y
reintento DISTINTOS: el 401+captcha es un *challenge* de sesión, no un bloqueo
de contenido, y un reintento puede consumir presupuesto sin cambiar el
resultado; **fetch failed / host no resoluble** (status.opencode.ai) → no es
anti-bot, es inalcanzable desde este entorno; **403 en el propio endpoint
`.json`** (reddit.com) → el hint de la tool induce un bucle de sugerencia (clase
documentada también en `sources/v4-1-flash-official.md:300`);
**cross-origin redirect NO seguido** (`deepmind.google/blog/*` → `blog.google`,
fb-1527 → canónico fb-177) → CUARTA clase: el fetch ABORTA con
`Error: cross-origin redirect to https://blog.google is not followed
automatically`. **No es un «gap» a corregir por defecto** (dictamen QH
2026-09-16, corrigiendo la propuesta inicial): `deepmind.google` y `blog.google`
son **dominios REGISTRABLES DISTINTOS** bajo el gTLD `.google` ⇒ **es un cambio
real de HOST, y NO seguir automáticamente a otro host es la superficie de
seguridad que el tool protege A PROPÓSITO.** ⇒ **REGLA: «mismo PUBLICADOR» NO
es criterio de seguridad; «mismo DOMINIO REGISTRABLE» sí.** El escalón correcto
**no** es seguir el redirect por defecto, sino **exponer el `Location` completo
en el error** (y acotar la URL de destino).

| Domain | Status | Observed behavior | Fallback |
|---|---|---|---|
| `businesswire.com` (www + secure) | **UNRELIABLE** | systematic 30 s timeout (fb-96/102/104) | one attempt max, then vendor primary |
| `tmcnet.com` | **BLOCKED** | HTTP 403 anti-bot (fb-97/103) | do not attempt; use mirror list |
| `zexprwire.com` | **BLOCKED** | HTTP 403 anti-bot (fb-98) | do not attempt; use mirror list |
| `openai.com` (openai.com/index/*) | **BLOCKED** | HTTP 403 anti-bot vs datacenter IP (rounds 08-25, 09-06, 09-07, 09-08, 09-10; fb-211) | do not attempt; capture via search-provider content + dated secondaries |
| `alignment.openai.com` | **OK (POSITIVA)** | **HTTP 200 con texto COMPLETO** (round 09-17; fb-1779) — **subdominio fetchable del MISMO publicador cuyo apex (`openai.com`) es 403** | **usar como primaria DIRECTA** para las divulgaciones de OpenAI (p. ej. `/misalignment-reports/`); **NO confundir con el apex bloqueado** — son hosts distintos |
| `aireleasetracker.com` | **UNRELIABLE** | HTTP 429 rate-limited (round 09-07; fb-211) | one attempt max, then tracker cross-check via search snippet |
| `es.dataconomy.com` | **BLOCKED** | HTTP 403 anti-bot (round 09-08, fb-236; corroboración GPT-6 Astra) | do not attempt; use dated secondaries (e.g. gadgetsnow/digitaltrends) |
| `pricepertoken.com/model-releases` | **UNRELIABLE** | HTTP 404 URL drift (round 09-08; fb-236) | do not attempt; use ThursdAI / aireleasetracker for release-gap checks |
| `media.defense.gov` | **BLOCKED** | HTTP 403 anti-bot vs datacenter IP (round 09-09; fb-286) — gov advisories (e.g. CSA) not fetch-able | one attempt max; capture via search-provider + dated secondaries |
| `www.ainvest.com` | **BLOCKED** | HTTP 403 anti-bot vs datacenter IP (round 09-09; fb-297) | one attempt max; capture via search-provider snippet |
| `www.axios.com` | **BLOCKED** | HTTP 403 anti-bot vs datacenter IP (round 09-17; fb-1779 → PLEGADA a fb-442) — **reproducido por el QD horas después, verbatim ⇒ determinista, no un fallo de una sola llamada** | **one attempt max** (regla de presupuesto `fb-286`); capturar por snippet del search-provider o **secundaria fechada** |
| `linux.do` | **BLOCKED** | HTTP 403 (round 09-10; fb-329) — 1 intento, abandonado | do not attempt; su contenido (comunidad CN) ES legible por el **mirror `locdd.com`** (Discourse JSON, HTTP 200) |
| `status.opencode.ai` | **UNREACHABLE** | fetch failed desde este entorno; **sin status page verificable**, y no distinguible como DNS vs anti-bot (round 09-10; fb-330) | do not attempt; usar el patrón del status-page-repo (p. ej. Upptime en GitHub) o el releases API |
| `www.investing.com` | **BLOCKED** | **403 anti-bot plano** vs datacenter IP (round 09-10; fb-333) | do not attempt; snippet del search-provider o mirror fechado |
| `reuters.com` | **BLOCKED (variante de clase)** | **HTTP 401 + captcha DataDome** (round 09-10; fb-334) — challenge de sesión, NO bloqueo de contenido | do not attempt (el reintento no cambia el resultado); usar **secundarias fechadas** (p. ej. digest The Neuron) + snippet |
| `mp.weixin.qq.com` | **BLOCKED (captcha, 200)** | HTTP 200 con **redirect a `/mp/wappoc_appmsgcaptcha`** y cuerpo «环境异常…» (fb-334) — **TERCERA forma** de la familia captcha, challenge de **SESIÓN**: no es un 403 anti-bot (la taxonomía separa las clases) y su reintento **consume presupuesto sin cambiar el resultado** | do not attempt; secundaria fechada o mirror del mismo contenido |
| `huxiu.com` | **UNRELIABLE** | **timeout del PRESUPUESTO de 30 s** (fb-102, `en-estudio`: no per-call timeout override) | one attempt max, then vendor primary |
| `reddit.com` (incl. `.json`) | **BLOCKED** | HTTP 403 también en el endpoint `.json` que el propio hint de la tool recomienda (round 09-10; fb-370) ⇒ **bucle de sugerencia** | do not attempt; snippets + secundarias; la clase ya constaba en `sources/v4-1-flash-official.md:300` |
| `www.googblogs.com` | **BLOCKED** | HTTP 403 anti-bot (round 09-10; fb-410) — espejo NO oficial de blogs de Google | do not attempt; el **blog primario** `developers.googleblog.com` responde 200 (misma pieza) |
| `techtarget.com` | **200-TRUNCATED** | HTTP 200 con **cuerpo servido truncado** (fb-843) — clase «200-inservible» (ver tabla hermana) | no reintentar el mismo fetch; secundaria fechada o subpágina concreta |
| `4sysops.com` | **BLOCKED** | HTTP 403 anti-bot vs datacenter IP | one attempt max; capturar por snippet del search-provider o secundaria fechada |
| `anadolu.agency` (+ fallback punycode `xn--anadoluajans-d5b.com.tr`) | **UNREACHABLE** | **fetch failed**, y el fallback **punycode falla igualmente** (host no resoluble, clase `status.opencode.ai`) | do not attempt; la fila ÚTIL es **`www.aa.com.tr` = `200-TRUNCATED`** (clase fb-843) ⇒ ir directo a ella o a secundaria fechada |
| `servicenow.github.io/eva` | **READABLE via proxy** | la página NO es «fuente inaccesible»: en directo es 200-inservible (shell JS), pero **con `r.jina.ai` da HTTP 200 y cuerpo COMPLETO** — es el WORKAROUND que funciona (mismo patrón que `docs.hetzner.com`) | fetch proxiado **`https://r.jina.ai/https://servicenow.github.io/eva/`** |
| `deepmind.google/blog/<slug>` | **REDIRECT-NOT-FOLLOWED** | **CUARTA clase** (fb-1527 → canónico fb-177): `Error: cross-origin redirect to https://blog.google is not followed automatically` ⇒ el fetch ABORTA. **NO es anti-bot** (el destino responde 200) **y NO es un fallo a «arreglar» siguiendo el redirect**: `deepmind.google` y `blog.google` son **dominios registrables DISTINTOS** ⇒ no seguirlos es la superficie de seguridad DELIBERADA del tool | ⚠️ **el workaround NO es gratis: cuesta 2 llamadas, no 1** — (1) el redirect abortado + (2) el destino `blog.google`, que devuelve **200 TRUNCADO** ⇒ **acotar a una sección concreta**. Mejor aún: ir directo a la **superficie técnica** (`ai.google.dev` model page, model card) + secundaria fechada |
| `blog.google` | **200-TRUNCATED** | HTTP 200 con **cuerpo truncado** (fb-1527 → fb-177) — 200-inservible; el mensaje pide «more specific URL or section» **sin decir qué sección** | acotar a la **sección concreta**, o mejor ir a la **superficie técnica** (`ai.google.dev` model page / model card) + secundaria fechada |
| `36kr.com` | **BLOCKED (interstitial)** | **interstitial anti-bot** («正在进行安全检测...») — 1 intento, abandonado (fb-1527 → fb-177) | do not attempt; **no se sorteó a propósito**: usar secundaria fechada o el anuncio del vendor |
| `huggingface.co/api/models?sort=createdAt` | **NOT A DETECTOR** | feed dominado por repos de prueba personales ⇒ **no sirve como detector de lanzamientos de modelos** (negativo medido, ronda 09-16) | no gastar un fetch en él para detección; sí sirve como **gate** puntual; para lanzamientos, `huggingface.co/api/daily_papers?date=<fecha>` (machine-readable) + superficie del vendor |
| `01net`, `finance.yahoo.com`, `cionfluence.com` | reliable mirrors | HTTP 200 from this environment (fb-96/98) | OK as last-resort mirrors |
| vendor primary (blog/repo/model card) | **preferred** | e.g. `ridgesecurity.ai` blog etc. (fb-103/104) | FIRST choice for press releases |
| API/JSON endpoints (`api.github.com`, `registry.npmjs.org`) | preferred | machine-readable (monitor-dsh-updates) | FIRST choice for registry/data |

**Fallback ordering for a press release** (documented researcher guidance,
fb-103/104): ① vendor primary (blog/repo/model card) → ② the issuing wire's own
page (`businesswire.com` — expect the timeout, one attempt max) → ③
known-working mirrors (table above) → ④ wire-syndication **search snippets**
(`web_search`) to confirm publication/date. Never guess a date or URL; record
the current state of any source that changed or is unreachable.

### Clase «200-inservible» (fb-333/334 round + organizer 2026-09-10)

Cuantificado por el organizador sobre las rondas del 2026-09-10: **13 de 25
fetches quemados (52 %) fueron HTTP 200 INÚTILES** (shell JS, sección truncada,
cuerpo vacío) — es la clase DOMINANTE y **una tabla domain→status no puede
expresarla** (el dominio "funciona"). Datapoints y workarounds verificados:

| Fuente | Comportamiento 200-inservible | Workaround verificado |
|---|---|---|
| `gov.ca.gov` | 200 con **cuerpo servido truncado** (SB 813 / AB 1405, round 09-10) | usar **secundarias fechadas**; marcar la redacción estatutaria como UNVERIFIED |
| `docs.hetzner.com` (SPA Gatsby) | 200 con **cuerpo vacío** | **proxy de renderizado de texto `https://r.jina.ai/<url>`** (mismo contenido, HTTP 200) — usado y verificado el 09-10 |
| `www.hetzner.com` (páginas de producto) | 200 con los **€ inyectados por JavaScript** (precio en blanco) | `r.jina.ai/<url>` para render; para **precios de plan**, la tabla PRIMARIA de `docs.hetzner.com/.../price-adjustment` |
| `suno.com/blog/v6` | 404 por **URL drift** | ruta correcta `/blog/introducing-v6` |
| `status.commandcode.ai` | 200 en HTML pero **sin lista de incidentes por fetch**; `/api/incidents` → 404 | vía machine-readable = el **repo del status page** (Upptime) |
| `cve.org`, `nvd.nist.gov` (detalle) | cve.org JS-only; **NVD detail = shell 200 vacío** | **endpoint primario CVE = `https://cveawg.mitre.org/api/cve/<CVE-ID>`** (JSON, fb-377) |
| `blog.google` (destino del redirect de `deepmind.google`) | 200 con **cuerpo truncado**; pide «a more specific URL or section» **sin decir cuál** | **acotar a una sección concreta**; la segunda mitad del patrón: **el workaround del redirect NO saca del defecto, cae en ESTA clase** ⇒ contad **2 llamadas**, no 1 |

**Regla:** ante un 200 con contenido inservible, **no reintentar el mismo
fetch** — saltar directamente al workaround de la fila (render proxiado,
endpoint machine-readable o secundaria fechada). El arreglo de mayor impacto
para esta clase es de **motor** (timeout configurable, tolerancia a
`application/javascript`, seguimiento de redirects), no documental: techo del
arreglo por tabla ≈2-3 % de ahorro frente al 52 % de esta clase.

**Scope note:** `web_fetch` itself is harness tooling — this table is
documentation only, 0 code changes. A per-call configurable timeout /
automatic retry would be an upstream harness change (open, fb-102/104); the
table is the plugin-side mitigation (save the fetch budget).

**Nota sobre `fb-1527` → canónico `fb-177` (dictamen QH, 2026-09-16 — corrige
la propuesta inicial del emisor):** el escalón correcto para la cuarta clase
**NO es «seguir los redirects cross-origin por defecto»** — eso fusionaría dos
casos que la casa separa y debilitaría una protección deliberada. **Es exponer
el `Location` completo en el error.** `deepmind.google` → `blog.google` es un
**cambio real de host** (dominios registrables distintos bajo el gTLD
`.google`), no un redirect interno: **seguir automáticamente a OTRO host es
exactamente la superficie que el tool no debe cruzar sola.**
**Y la medición es del EMISOR (`daily-ai-news-18`), no reproducida por el QH ni
por el head:** se registra como tal.

## Index

`<workspacePath>/sources/INDEX.md` maintains the topic list (slug, title, tags,
`date`, `verified`). It is generated/updated by the organizer role
(weekly-report-organize) — do not hand-edit it.

## Relation

- Defined in `presets/departments/research/ARCHITECTURE.md` (knowledge system).
- The `researcher`/`reviewer`/`analyst` personas reference this directory; the
  researcher archives new sources; the reviewer verifies.
