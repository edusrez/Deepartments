# WORK-REGISTER — trabajo pendiente

> Registro TOTAL de trabajo pendiente de la organización Deepartments. Creado
> el 2026-08-27 (M3 SYNERGY-DOCS, decisión owner) a partir del contenido v1 del
> Asistente; lo mantienen el **Internal Programming Department (IPD)** y el
> **Asistente**. Es la fuente de verdad de la cola: IPD activa, DAG técnico
> cerrado, decisiones pendientes del owner, capacidad, backlog y sinergias.
> **LANDING 2026-09-02 (host Asistente)** — **MISIÓN TOTAL MODULARITY (0.2.x)
> COMPLETA — termómetro 7/8** (ver ROADMAP 09-02): lanes 0.2.1/0.2.2/0.2.3a
> (`e8222af`)/0.2.3b (`dc9f79a`)/0.2.3c (`48cea9f`) + fix fb-55 (`5210682`)
> cerrados y desplegados (canary 06:14Z); suite 720/698/0/22 EXACTA; re-freeze
> CUT-4 `5b548545`; dshmarket 1.40.0 + dsh-smooth-stream 0.4.3 live. Cola nueva
> post-DAG (DAG del IPH): DI-by-services (residual) · fb-57 · F6 · fb-50 ·
> fb-51/52 · feedback-nudge · GUI monitor · higiene reports.
> **LANDING 2026-09-01 (host Asistente, 2ª pasada de alineación)** — refresh
> completo al estado REAL post-bloque VALLE: M-4/M-A/PACING/D5/P1/publish
> commiteados y CERRADOS en su cola; bloque VALLE aterrizado (M-7 + fb-43 +
> fb-30 investigado + pulse-digest + MEMO NORM + materializePost cold re-spawn);
> hardening 401/fb-39 + fb-27 commiteados; fb-28 EN VUELO; backlog del día
> (fb-46/47, GUI modo monitoreo, T1 capa 3, watchdog work-register-idle)
> registrado; capacidad al día (owner: top-up no por ahora). Deriva detectada
> por el propio host al comparar con el ROADMAP (lección: sincronizar el
> register al CERRAR cada bloque — norma de continuación, fb-46).
> **LANDING 2026-09-03 (host Asistente)** — **DÍA DE INFARTO RESUELTO — apagón
> de coordinación ~2h cerrado + recuperación**: crash-loop build-0.1.2-vs-kernel
> (parche dual Stable) · keys Go inválidas/sin-crédito (usage 200 ≠ chat-auth) ·
> **pooler-gate branch 3 re-armado por lastRotation stale → materializePost
> bloqueado → cabezas sin despertar**. Workarounds: **key opencode-go del OWNER
> (chat-auth 200 — la única real) en oc-6** + gate-clean + restos en cooldown
> (monthly resets 23-28/09) → pool OK · **delivery vivo (m-416/417)** · fix
> formal en la delivery lane (commits 1-4). Cadena IPH: ① clasificador
> 401-invalid (en vuelo) → ② delivery lane + gate fix → ③ **stable :3080 —
> AUTORIZADO owner 09-03 (supersede "NO TOCAR" 09-01; RAG-stable sentinel
> aplica, §3)**. QD: inspección del incidente (2 inspectores; datapoints
> fb-79/fb-58/fb-83 — familia de aborts ampliada de mensajería a tools de
> operación). Suite 738/716/0/22 (fb-68). Commits del día 16+ (a00e8de último).
> **VEREDICTO QD consolidado (09-03, 3 inspectores — reporte
> .dsh/reports/quality/2026-09-03-incident-delivery-consolidated.md)**:
> incidente RESUELTO operativamente pero NO cerrable como clase — cadena
> confirmada con artefactos+código (pooler stale lastRotation 429→null 09-02
> 16:10:37Z → gate branch 3 dshd-health:3069-3077 SIN age-check, bloqueó con
> 6/6 usable → materializePost → 295 filas failed 13:54→17:02Z → gate-clean
> 17:02:34Z re-entrega 100% en 71s, 0 pérdida); **FIX FORMAL AUSENTE (lane ② =
> 0 commits en git — el gate-clean fue 100% operativo, no código)**; cierre
> formal de clase = lane ② + 48h de 0 failed (criterios §7 del reporte);
> **R1: branch 3 re-armable (sin age-check) — prioridad ALTA de la lane ②**;
> fb-58 recidiva doble (F-3: m-424/425/429 'prepared' x2 post-retirement,
> settle sidecar sin implementar); rotación host m-423 PARTIAL (archive corto
> ~85 líneas, m-426 delivered post-retirement).
> **LANDING 2026-09-07-VALLE (host 1662eecf; owner ausente con autonomía
> total; detalle: ROADMAP 09-07-VALLE + journal host-session-1662eecf)** —
> **BATCH-DRAIN DE MENSAJES APROBADO por el owner (drain-on-settle puro: al
> cerrar un turno la siguiente wake entrega TODA la cola pendiente; interrupt
> preempta y su wake trae el interruptor + todo lo pendiente; clases noWake/ack
> del wake-seam intactas; emergencias health-alert/franja SIN batching; idle:
> primer mensaje despierta, el resto en lote)** → misión PROGRAMMING REQUEST al
> IPD despachada (m-2563, prioridad ALTA; zona dshd-orchestration = la del
> wake-seam; secuenciar tras B3) · **B3: LIB LISTA, RUNTIME NO ACTIVO**
> (corrección QD post-estampa — el boot debc67ec cargó la lib STALE 09-06
> 21:50 pre-fix; m-2433/m-2468 entregados por OTROS caminos; OUTCOME 0
> residuales inalterado) · wrapper `recipientDormantForRedeliver` presente en
> lib/tools.js:4917/4936/4950/5563 (re-emit 10:27; mirror src
> tools.ts:5623/5640/5655/6259) → **ACTIVACIÓN = restart canary:true
> PENDIENTE** (sonda del primer tick post-restart = prueba real; mi «activo
> desde boot» inicial era incorrecto) · pooler /v1/models 200
> live ✓ · pool 4 keys sin billingBlocked · keyPooler-state.json STALE desde
> 03:58Z (pre-fix) con oc-15 usage 401 y usage% UNKNOWN en archivo →
> MONITOREO (lane A en vivo; verificar reescritura del archivo) · cola activa
> VALLE: gate salud pool pre-dispatch (fb-39/75 PRIORIDAD) · flujo-feedback IPD
> · O2 emitter · fb-198 T1-T4 · atribución restarts (fb-43) · re-triage CORTE
> #2 · **QH ROTADO (11fdee57→dab1b424, guardrail b5 ejecutado ~11:0xZ; handoff m-2573)** · RD brief 09-07 en curso
> (daily-ai-news-8) · **D-Q3 DE LA ROTACIÓN DEL HOST 1662eecf (q-i-92) PASS-CONDITIONAL** (C1 = B3 runtime, mi restart GO · **C2 O1: noWake→destinatario retirado = prepared-stuck [drop/fail o re-puntar al sucesor — clase delivery-seam, hermana del batch-drain m-2564]** · C3/O4: punteros stale del seed · O2 8º datapoint emitter · **O5: monitor de contexto del host SILENCIOSO un ciclo (12h15m) — no fiarse de alertas para el propio umbral; calibrar por journal**).
> **LANDING 2026-09-06 (IPD — ola post-PREP CERRADA 10/10 LISTO-PARA-COMMIT)** —
> despacho host m-2077 (ola post-PREP, 12 lanes) CERRADA: 10 LISTO-PARA-COMMIT ·
> fb-51 parkeada-owner (revisión del host) · §5.5 diferido. Estado por lane
> (tokens de reporte): fb-134 `64ccedd9` · fb-132 `d0a8a4b2`+`d93d46a3`+`e9ac4720`
> (12 archivos) · fb-163/164 `963e627e` · P2-hygiene `ce467a44` (B+A-snapshot;
> A-harness=DECISIÓN HOST pendiente, topología upstream deepseek-harness-fb51
> `d347e703`) · fb-118 `fcb9361b` · fb-175 `f144dbb7` · fb-184 `6bd67800` ·
> canary P0s `02826cca` · fb-190 `d007c408` · QI-48 `e1f3838e` · fb-51
> revisión-host parkeada-owner → push-day · §5.5 diferido. **MERGE ORDER
> recomendado al host**: fb-132 → fb-118 → fb-175 → fb-163/164 → fb-190 →
> hygiene B+A-snapshot → fb-134 → canary-delta dsh-smart-restart → fb-184 →
> QI-48 → A-harness por decisión. **NO ENTRARON EN ESTE CICLO** (siguiente
> bloque post-ceremonia): fb-155 reconcile latches scheduler · franja flip
> fb-149 · §5.5 opcional · lock-fix clase fb-95/loader-suite · canary fase 2
> (smoke aislado + cross-check q-i-61) · QI-48-A (owner) · fb-51 push-day
> (owner).
> **LANDING 2026-09-06/09-07 (IPD — SYNC WORK-REGISTER↔ROADMAP, ítem 0 del
> BLOQUE 2 P2; cotejo con la REALIDAD: git log 09-04→09-06 · worktrees wt-* ·
> journal IPH 09-06 · reports 09-06 · ROADMAP 09-04..09-06)** — el register
> vuelve a ser la fuente de verdad de la cola (protección anti re-despacho):
> (1) **waves R1-R10/W1-W7 ATERRIZADAS 09-05** (commits 11ca2bb R1 · 82a474f
> R2 · 476f5f2+7600bd2 R3 · f8ce69a R4 · e3db75c R5 · c9c1380 R6 · 3125c16
> R7 · a3ecfb7 R8 (fb-143/144/145) · 3fe5f0d R9 · 3224713 R10 (fb-82) ·
> 9308e3d W-1 · 00572b6 W-2 (fb-33) · af4757c W-3 · 4d03b43 WFD · 7c1c424
> fb-37 · 0559e6b P-DOCS · 3b96433 P-LATCH (fb-154/155/157) · 206ceb8
> P-DOCS2 · 016f1d8 P2-ENTRY · 3db2617 fb-167 · fe5cab4 fb-132); (2) **fb-27
> §7 RENUMERADO = 9 SANCIONADOS + artefacto429 + 0 no-planificados** (cierre
> 09-06, docs `562d994`; NOTA: el ítem «fb-27» CERRADO de este register =
> turn/end-error notify `04f8c31` — OTRO ítem distinto del §7 del ledger);
> (3) **key_14/oc-14 (P1-op, fast add owner 09-05, canary 11:33:17Z PASS) +
> P-POOL probeDegraded (`2c2bdda`)** — pool 09-06: oc-6 key NUEVA del owner
> (ws6) única elegible · oc-13/14 blocked→09-07 00:00Z · resets 09-07 → ~3
> usable; (4) **auditoría key m-2327 ✓ (explore-deep-35): la «4ª key» = la
> MISMA oc-6 con consumo invisible al pool** (bypass directo de providers
> hermanos en settings.yaml + medición /usage degradada; fixes ALTA: cerrar
> bypass + desplegar lane A usage-poll — P2); (5) **M1 ✓ (f7fdc16e, reviewer
> e30fc08f) · M2 diffs ✓ · HALT ✓ (7c6d3376, reviewer 6daac83e) — PIPELINE
> P1 IPD CERRADO (m-2327 ✓ · m-2338 M1+M2 ✓ · m-2333 HALT ✓)**, consolidación
> al host m-2382; (6) **CEREMONIA 09-07 ~10:00Z — 13+2 lanes LISTO-PARA-
> COMMIT (detalle §1)**: 13 worktrees wt-* (fb-132 · fb-118 · fb-175 ·
> fb-163/164 · fb-190 · fb-134 · fb-184 · fbd-nudge-o2 · fb-50 · fb-52 ·
> ola-landing · p2-hygiene-a · pool-hmax-p1/HALT) + 2 lanes pooler (lane A
> knobs/usage + M1 wt-builder-149) + M2 diffs a config (settings.yaml→pooler,
> ventana deploy) — COMMITS DEL HOST; (7) **familia errores host
> (fb-137/163-172) investigada QD + prácticas vinculantes + fixes
> estructurales W7 (fb-167 + fb-132) EN MAIN**; (8) **clase delivery CERRADA
> 09-04** (fb-79/116/117/130/131 — 7d5bb70/91bc5a8/0e2e735/3386f7b/c19cde4)
> · **fb-78 A2 CERRADO** (`939e942`, offlineReap ignition); (9) **BLOQUE 2 P2
> (NO-GATEADOS) — ítem 0 = ESTE sync**; resto: transporte fb-23/69/70/81/83
> (REABIERTA por reloj — ver el ítem §1; fb-58 CUBIERTO `ec2d405`, fuera de
> cola) · fb-56 · O2 nudge (lane LPC) · zombie rule pooler · m-423 · fb-32 ·
> qi-silence m-2347.
> **ENTRADA 09-07 — DÍA DE LA OLEADA (IPD, cierre de wave; 2026-09-07 ~16:25Z;
> firma IPD — REGISTER-SYNC, absorción de lanes doc)** — oleada del día (todo
> ATERRIZADO en main, commits → lane/worker): **fix sweep B3** `ea75a4d`
> (sweep-dormancy: recipientDormantForRedeliver liveness-aware host-only + O1
> ACK-class + CUT-4 re-freeze; lane wake-seam) · **O2 pieza A** `ea48a67`
> (emitter observability: deliveries.jsonl sidecar 'terminal' + retire-dice.jsonl
> ledger; IPD builder-165, micro-lane-o2-b155, audit explore-deep-48/912d67dd) ·
> **pooler M1 + lane A** `96f2fb7`/`9990567` (dsh-key-pooler: x-opencode-session
> header en TODO outbound — Console Go lo exige; usage-poll periódico + weekly-
> warn early-freeze; knobs usagePollIntervalMs 300000 / weeklyUsageWarnPct 75;
> OWNER 09-06) · **HALT (m-2333)** `e0035e6` (pool-governance MAXIMA MAQUINA;
> lane wt-pool-hmax-p1, reviewer-81 PASS 6daac83e) · **O1** `0ee5a26`
> (pool-health gate pre-dispatch: billingDown fb-75 + halted P4 duráveis) ·
> **batch-drain + C2** `a641964` (drain-on-settle + noWake→retired 'failed';
> PROGRAMMING REQUEST 1662eecf, spec explore-deep-47/b99b8ce6) · **wave B**
> `f668508`/`6133b2e`/`69fbc27`/`d0d6af1` (fb-134 store separation + fb-118
> verify-cite + p2-hygiene-A snapshot-anchor + fb-184 work-register-idle v2;
> IPD builder-170 FASE B wave-b, reviewer-87 GO 9/9) · **fb132** `68384de`
> (wake-on-delivered FIFO + cap 25 + retired-flavor; IPD builder-171 rb
> 8b4c43d2, reviewer-88 PASS, QA doble q-i-99+reviewer-88) · **canary**
> `ca229bd` (dsh-smart-restart dep rc.7→0.1.2-rc.1; builder-163 ff1ae5bc) ·
> **2ª OLA post-REGISTER-SYNC (aterrizada 63d3c2c→dc05904; cierre de wave;
> commits → lane/worker)**: **A-harness** `27142eb` (port patches, modalidad
> (c): payload 25-rutas como patch-chain — 9 patches [web/fetch edit-DX
> fb-85/89/90/102/107/108 + fs-search anchor literal-glob + app-boot/CLI
> watchUserPatchLayers R3] + scripts + manifest + README, fingerprints md5 y
> smoke; **web-fetch-http EXCLUIDO** — verificado host 09-07; builder-173
> cfc0afac) · **head-tooling 6/6** `0f6a680` (6e39bbe..0f6a680: O4
> registry/spawn/tools-h2 status (worker-spawn persiste title+jobId en
> posts.json) · fb-209a `dept_repo_state` + CUT-4 re-freeze · fb-212-216/
> 220/223 memo validator (dept_memo_write enumera TODAS las violaciones) ·
> dept_head_rotate fb-220 · guards dept_exec fb-214 · test caso host
> batch-drain; 7/7 lanes, 6 commits) · **FB-198 4/4**
> `dea0c4e`+`e12478b`+`3faa9cb`+`4525ff8` (T1 código — send_message NUNCA
> bare-failed para registro persistido + re-freeze CUT-4 → f919606a +
> asserts; T2 health — key delivery-failed no-renumerable + hunk W6 signed;
> T3 test ventana wake-fails → terminal settle ONCE; T4 documentado — clase
> de fondo delivery-failed, SIN dedupe engine) · **O3-a** `7cc942c`
> (estampa re-runs manuales dept_job_run en job-runs-state, misma forma
> flat {jobId: lastRunAtMs}; jobs 31/31) · **O3-b** `7d090a7` (auto-backfill
> clase-outage 400/503/429: collector + runJobBackfillTick + stores
> job-runs-backfill/detail; jobs 42/42) + **re-freeze** `fd632e5`
> (binder-contract lock main-red jobs += backfillPoolDispatchBlockError,
> 1+/1−) · **O6** `644f584` (aserción baseline rotación spec 002 M1:
> verifyRotationBaseline puro + suite hermética no-live rotation-baseline
> 21/21 + bridges R6) · **fb-43 §7** `dc05904` (atribución de restarts:
> script host-run backfill-restart-registry.mjs [rewrite atómico + anti-
> race + dry-run/apply] + plumb cause crashStreak — **backfill VIVO
> ejecutado 14/46 causas del ledger QI-48; backup
> /opt/dsh/backups/restart-registry-*-pre-fb43**; fb-43 6/6, parity
> intacta).
> **ENTRADA 09-08 — ABSORCIÓN DE LA JORNADA (IPD builder-188, lane paralela
> register-sync 09-08; docs-only, 0 commits, LISTO-PARA-COMMIT — el host escribe
> la entrada ROADMAP al cierre de sesión)** — jornada 09-08 absorbida
> (commits → lane/worker, 1 línea de contenido c/u): **fb-221 work-register-idle
> v2** `abed5f0` (CERRADO — el parse excluye closure-markers
> CERRADO/DIFERIDO/ABSORBIDO/DONE/RESUELTO/RETIRADO del conteo actionable; la
> alerta cita pendientes REALES; 156→N activos + conteo total informativo en el
> cuerpo; +3 tests; WRI 23/23, parity 3/3, CUT-4 intacta; lane
> work-register-idle) · **O5-flags F1/F2/F3** `3b5d65c` (CERRADO — HEAD main:
> F1 warn del drop silencioso quality-head en delivery · F2 reason qd-worker|dice
> en el ledger retire-dice · F3 kind prune-reinventory en el archive
> posts-retired; O5 veredicto intacto; parity 3/3; lane obs/O5) · **SOURCES.md
> research** `3f17879` (CERRADO — fb-211/fb-236 doc research: tabla dominios
> BLOCKED/UNRELIABLE + fallbacks datados; commit por el host; lane research-docs)
> · **fb-190 CERRADO (cadena completa, 2026-09-08)** — protocolo de rotación sin
> pre-anuncio, codificado en runbook hosts `f4595b15` + `671b6ac5`; resuelto por
> QH; pre-anuncio PROHIBIDO · **rotación host D-Q3 PASS** (q-i-112, report
> 537bb463 — f4595b15→671b6ac5, artefacto doble start-match explicado) ·
> **rotación QH completada** (b5, sesión 8637062a) · **fb-237 CERRADO** (retiro
> involuntario builder-184 → auto-retire-on-delivery del protocolo efímero
> aplicado a un turno de PAUSA — D-Q2 QH CERRADO; causa de DISEÑO del efímero,
> lección para briefs IPH; 0 pérdida, re-despliegue 185) · **fb-239 DESCARTADO**
> / **fb-240 en-estudio** / **fb-238 ABIERTA** (head-tooling) · **fb-241 CERRADO
> COMPLETO (09-08)** (higiene secrets: repo redactado + ACL 600/700 + corpus-
> limpio — RAG rebuild 19:27Z corpus 1827, journals 0 sessions/archive, 0
> valores completos; **rotación de key DECLINADA por owner** — m-3268, decisión
> 09-08 §3) · **oc-15 REVIVED (09-08, m-3282)** (revalidate → probed/revived
> [oc-15]: totalKeys 4 · eligibleKeys 4 · invalid:false · invalidSince 0 — el
> fix del prefijo `sk-` confirmado en el boot: drop-in key-pooler.conf saneado
> desde el env vivo (source-trace explore-deep e5d1d3f9); el re-plan v2 quedó
> CERRADO por la ejecución host; paquete inicial `955ced02` cancelado)
> · **ghost-store fb-242/fb-222 EN CURSO** (anclaje de rutas absolutas — path
> real verificado `/.deepartments/`; explore-deep diseñando) · **lane
> fs-tooling unificada 09-08 YA EN MAIN** (`3168e8e` guard O1
> deptExecIsQuotedInlineScript q-i-110 + `b901bbc` patch SEARCH_PATH_NOT_FOUND:
> pre-chequeo de path en runRipgrep + fallback stderr + wording 'pattern
> rejected'; grep único previo 0 hits — sin duplicado) · **`a27daaf`
> chore(manifest) bookkeeping** (re-freeze 12 zonas a-harness-* al estado
> aplicado — A-HARNESS deploy apply 12/12 + smoke 10/10, 09-08 01:31:48Z;
> hallazgo de completitud del reviewer def6926b: NO citado en la entrada →
> aquí junto a fs-tooling/A-harness; chore de manifest SIN semántica de
> ítem/lane, absorbida en la ola 2ª `27142eb`) · **prepared-stale → RESUELTO
> (09-08)**: población m-3034/m-3037 a f4595b15 resuelta por
> supersede/delivered (WATCH C2 m-3265: m-3034 delivered al host vivo
> 671b6ac5 14:26:27Z · m-3037 cubierto por el supersede m-3040
> terminal+delivered · prepared residuales a destinatario RETIRADO = historia
> append-only NO-accionable; 0 purga, 0 script ad-hoc) — higiene FUTURA =
> lane **fb-253 → CERRADO 09-09 (markDelivery CLI**: `5ab20ea` CLI + `a60cb4d`
> adenda hosts retirados; drenaje --apply EXPRESO del host m-3019/m-3022 →
> preparedStuckRemaining=0; el CLI y su uso ya documentados en §7 — no se
> duplica en §1), NO script ad-hoc (record QH m-3271; ver §1 ítem).
> **DECISIÓN DE COLA (head; estampada por esta lane)** — ítem transporte =
> CIERRE FORMAL + re-lane «pooler-capacity / reserva de keys» (ver §1).
> **ENTRADA 09-09 — ABSORCIÓN REGISTER-SYNC (IPD builder-212, lane register-
> sync 09-09; docs-only, 0 commits, LISTO-PARA-COMMIT — verify + add EXPLÍCITO
> del ÚNICO archivo docs/WORK-REGISTER.md)** — jornada 09-09 absorbida
> (commits → lane/worker): **fb-253 CERRADO 09-09** (cadena `5ab20ea` CLI
> mark-delivery + `a60cb4d` adenda hosts retirados [builder-209 374f527d,
> reviewer-114 19785a52, QD dq2-5b8597cb; tests 17/17] + **drenaje --apply
> EXPRESO del host m-3019/m-3022 → preparedStuckRemaining=0** — ver su ítem
> CERRADO §1 + §7 CLI) · **fb-251 (clase bare-400 — 2ª ventana, record
> canónico IPH)** (causa raíz 2 capas: 400-no-body intermitente del UPSTREAM
> + misclasificación pi-ai overflow.js:60 → CONTEXT_WINDOW_EXCEEDED falso;
> fix `c96b40a` errorSurface.code en post-errors.jsonl LIVE tras canary
> 12:05:28Z; PENDIENTE-OWNER: acotar patrón pi-ai por provider +
> dsh-compaction-basic:803 — record en-estudio) · **fb-235 (instrumentación)**
> (captura pooler `f3d9c87` key/workspace ACTIVA tras deploy canary 12:05Z —
> próximo bare-400 loguea key+workspace; record en-estudio) · **fb-272
> CERRADO por QD 09-09** (prune-on-delivery = INTENCIONAL — delivery auto-
> retire seam delivery.ts:1540-1558, benigno 7/7, resuelto-documentado, NO
> lane de ajuste) · **fb-284 RESUELTO 09-09** (marker ghost-store anotado:
> rename reversible capacity-gate-state.json →
> .stale-2026-09-09-annotated-fb284, fuera de parseo, NO purga) · **fb-285
> ABIERTO (QD, limpieza GLOBAL ghost-store /root/.deepartments — debris
> huérfano 08-23→09-06 incl. secrets/; PENDIENTE-OWNER: purgar vs
> anotar/archivar; revisión secrets/ fb-16)** · **fb-234 CERRADO-absorbido**
> (su next: host CUBIERTO por 6397fb5 + cadena VALLE — ver ítem §1) ·
> **fb-75 nota de cierre formal** (gate billingDown aterrizado O1 `0ee5a26` +
> pooler `5fc59b5` + HALT LPC `7c6d3376` — el record QD fb-75 permanece
> EN-ESTUDIO, watch QH#10 09-08; ver ítem §1 pooler-capacity) · **§3
> stable-profile 19 → 25 releases al 09-09** (monitor 09-09: dshmarket
> 1.21.2→1.45.1 + smooth-stream 0.3.4→0.6.0) · **O2-nudge fbd-nudge-o2
> `8e03c04d` LISTO-PARA-COMMIT pendiente del host** (verify+commit; ver §5).

## 1. IPD — cola activa (DAG seriado, lección fb-20: UN lane a la vez)

> **FORMATO `next:` (convención docs — diseño fb-184 ITEM 4,
> reports/explore-deep/2026-09-06-fb184-watchdog-idle-v2-design-586effda.md
> §ITEM 4; el PARSE es lane separada fb-184, aquí SOLO la convención del
> registro)**: cada item del DAG IPD lleva `— next: <actor>` nombrando al
> PRÓXIMO actor que lo toma. Patrón: `**<label>** … — next:
> internal-programming-head` (items de implementación/IPD) · `next: host`
> (settlements / push+verify del host — clase settlement-wait fb-167, convención
> ya adoptada en el registro). El watchdog work-register-idle v2 (fb-184) lee
> este campo para notificar «next-actor-idle» al actor nombrado.

- **fb-234 (canary-vs-crash + writer restart-reason.json + incidente ALTO phantom)** — CIERRE FORMAL (absorción register-sync 09-09, IPD builder-208; no entró por la cola del día; cadena completa: `07b4f59` sidecar → `5a310ad` writer (builder-205/11c53eec) → `71d05b5` A2+A1 perimetría (builder-206/9645cbfe) → `8fb403f` deepartments GAP-2 bootId-coherence + `c20c7dd` dsh-smart-restart GAP-2 deriveLiveStateDirOverrides (builder-207)) · validación EN VIVO post-GAP-2 (canary 06:44:12Z): boot real 59c8891c recoveryCause 'canary' crashStreak 0 · marker restart-reason AUSENTE (consumido por el BOOT REAL) · fila restart-registry del sucesor = 'canary' con bootId IDÉNTICO al sidecar (guard dshd-health:6810-6811) · efímero canary 0 huellas (0 filas config → /.deepartments — acceptance 1 por construcción) · dshmarket 1.45.1 activo (doble deber) · acceptance (1)-(4) CERRADAS (reportes del día 11c53eec/d11779d1/9645cbfe/69782011/4fc62dce/34c5347d + traces 806784e2/f51a8760) · NOTA DE ATRIBUCIÓN: streak nocturna 20→21→22 (09-08T19:00Z→09-09T00:10Z) + filas 'unknown' @00:33Z/05:53Z = PRE-fix (boots marker-less) · GAP-2 re-atribuyó filas del 09-08 (d8ac0f23/549a405c → 'smart_restart canary') · «CRITICAL streak-19» digest 09-08 = PRE-fix → SUPERSEDED — next: host (commit de cierre) CUBIERTO (register-sync `6397fb5` commiteado por el host 09-09 + cadena VALLE del día `461e3fa`/`a60cb4d`/`c96b40a`/`05963b4`) / QD (verificación streak opcional) — CERRADO-absorbido (register-sync 09-09, builder-212)
- **OLA POST-PREP (despacho host m-2077, 09-06 — DAG seriado del IPH, la ola
  post-PREP del wave; cada item con su `next:`):**
  - **fb-134 (store separation — único gated, destrabado con el cierre PREP
    562d994; F0+F2, lane builder-131)** — next: internal-programming-head —
    CERRADO (reporte 64ccedd9)
  - **fb-132 2ª mitad (gate/wake-seam settle — fe5cab4 liquidó el settle;
    liquidar lo restante, nunca re-marcar prepared)** — next: internal-programming-head
    — CERRADO (reporte d0a8a4b2+d93d46a3+e9ac4720, 12 archivos)
  - **fb-163/164 (política de despacho — informed-dismissal + gate-breadth;
    digest QD junción 09-05)** — next: internal-programming-head —
    CERRADO (reporte 963e627e)
  - **P2 hygiene (rebase search-core P2)** — next: internal-programming-head —
    CERRADO (reporte ce467a44; B+A-snapshot; A-harness=DECISIÓN HOST pendiente,
    topología upstream deepseek-harness-fb51 d347e703)
  - **fb-118 (fix, 4 datapoints)** — next: internal-programming-head —
    CERRADO (reporte fcb9361b)
  - **fb-175 (L1336)** — next: internal-programming-head —
    CERRADO (reporte f144dbb7)
  - **fb-184 (watchdog work-register-idle v2 — diseño explore-deep-34
    586effda; CONSUME esta convención `next:`)** — next: internal-programming-head
    — CERRADO (reporte 6bd67800)
  - **canary P0s (artefactos builder-126 post-restart canary — verificación
    del host)** — next: host — CERRADO (reporte 02826cca)
  - **fb-190 (mejora protocolo rotación — no pre-anunciar)** — next: internal-programming-head — CERRADO (reporte d007c408)
  - **fb-51 (thread bilingüe + branch portador — REVISIÓN del host ANTES de
    publicar; no publicar sin su visto bueno)** — next: host —
    DIFERIDO (revisión-host parkeada-owner → push-day)
  - **QI-48 (registry post-cierre lane)** — next: internal-programming-head —
    CERRADO (reporte e1f3838e)
  - **§5.5 (opcional)** — next: internal-programming-head —
    DIFERIDO (opcional)

- **CEREMONIA 09-07 ~10:00Z — 13+2 lanes LISTO-PARA-COMMIT (todo doble-
  verificado; journal IPH 09-06 16:57Z; merge order recomendado en el LANDING
  ola a9d71c24; COMMITS DEL HOST — los worktrees wt-* son ajenos, NO tocar):**
  - **13 worktrees wt-* (detached; base 562d994 salvo fb-132=92a0f21):**
    fb-132 wake-on-delivered (iter `857d35a6`/`d0a8a4b2`+`d93d46a3`+`e9ac4720`,
    HEAD 92a0f21) · fb-118 verify-cite (`fcb9361b`) · fb-175 missionqueue-fp
    (`f144dbb7`) · fb-163/164 policy (`963e627e` — WORK-REGISTER +49/-1, sub-
    normas §7 ANTI-163/171 y ANTI-164) · fb-190 rotation-protocol
    (`d007c408`) · fb-134 store-separation (`64ccedd9`) · fb-184 watchdog
    work-register-idle v2 (`6bd67800` — incl. sub-norma welcome §7) ·
    fbd-nudge-o2 (`8e03c04d`) · fb-50 ma-calibration (`bf270283`) · fb-52
    guard (`4b2768a4`) · ola-landing (`a9d71c24` — LANDING 09-06 ola) ·
    p2-hygiene-a (`ce467a44`, B+A-snapshot; A-harness=DECISIÓN HOST) ·
    pool-hmax-p1 **HALT** (`7c6d3376`, reviewer-81 PASS 6daac83e — m-2333).
  - **+2 lanes pooler (repo dsh-key-pooler):** **lane A** (main tree master
    5fc59b5 — knobs lane A + usage-poll/usage-agg: usage-poll.ts + test en
    working tree, reports 02826cca/b09032be) · **M1** header x-opencode-session
    (dsh-key-pooler-wt-builder-149, `f7fdc16e`, reviewer-80 PASS 5/5 e30fc08f
    — m-2338).
  - **M2 diffs a config** (settings.yaml→pooler rewire · knobs lane A ·
    usageTimeoutMs 25s · ws6≠ws13/14) — el HOST aplica en la ventana deploy.
  - **PENDIENTES HOST (ceremonia):** commits 13+2 + M1 (add -p tras lane A) +
    M2 config + HALT · verificación post-restart + **rotaciones IPH/QH
    DIFERIDAS a la junción post-ceremonia** (m-2175/2178; QH 58%/IPH 56% —
    cruce b5, no-emergencia) · re-enable canaryAgentCheck (quitar TEMP) ·
    A-harness por decisión · canary restart contra M1 · verificación
    /v1/responses muse-spark (post-M1).
  - **Ola 10/10 (ola-landing a9d71c24) — entran también en la ceremonia:**
    canary P0s dsh-smart-restart (`02826cca`) · QI-48 (`e1f3838e`) · hygiene
    B (p2-hygiene-b-wt) · fb-51 y §5.5 DIFERIDOS (ver LANDING 09-06).
- **SINCRONIZACIÓN 09-06 (ítem 0 BLOQUE 2 P2 — register↔ROADMAP; ESTE sync):
  aterrizado en main 09-04..09-06 y AHORA registrado** — bloque 09-04:
  pool-grading M1 (`47a8f34` — 3 clases warning/ok/critical, knobs 1/2/20/10,
  fb-75 ESPECIFICADO) · offlineReap fb-78 A2 (`939e942`) · fold-ins
  (`7d5bb70` fb-116/117 · `91bc5a8` micro-fixes fb-32/106 · `0e2e735` tramo 3
  O4/nudge/fb-25-109 · `3386f7b` O1-EXT fb-23 · `c19cde4` wake-seam
  fb-130/131) · R1 probe-failed (`11ca2bb`) · R2 N%+probe mint (`82a474f`) ·
  R3 HMR aviso (`476f5f2`) + zod mirror (`7600bd2`); bloque 09-05: waves
  R4-R10/W1-W7 (ver LANDING arriba) + **fb-27 §7=9 cierre 09-06** (docs
  `562d994`; 9 sancionados + artefacto429 + 0 no-planificados — el §7 es el
  ledger de reinicios, distinto del ítem fb-27 `04f8c31` CERRADO del register)
  + **restart canary re-escopeado** (pooler 094cbf8/2c2bdda/5fc59b5 +
  plugins smooth-stream 0.6.0/dshmarket 1.43.0 + R8/R9 runtime vía G1 +
  smoke guard fb-168 + fe5cab4 runtime drena cola prepared fb-137 —
  verificación post-restart del host OK).
- **FAMILIA ERRORES HOST (investigación QD 09-05, 5 intervenciones owner) —
  estado (sync 09-06):** fb-163 (informed-dismissal) · fb-164 (gate-breadth)
  → lane fb-163/164 LPC (política + sub-normas §7 ANTI-163/171 + ANTI-164,
  `963e627e`) · **fb-167 (fallo de arquitectura del eslabón verify+push —
  settlement-wait watchdog EN MAIN `3db2617`)** · **fb-132 (gate/wake-seam
  settle — EN MAIN `fe5cab4` + iter LPC `68384de`)** (2ª mitad CERRADA 09-07 —
  nunca re-marcar prepared) · fb-137 (jam host-inbound +
  seq-rewind — re-deliveries m-1999/m-2024; `fe5cab4` drena la cola prepared
  en runtime; población prepared-stale 09-08 m-3034/m-3037 a f4595b15
  RESUELTA por supersede/delivered — WATCH C2 m-3265; higiene futura =
  lane fb-253 CERRADO 09-09 (CLI `5ab20ea` + adenda hosts `a60cb4d`; drenaje
  --apply EXPRESO host m-3019/m-3022 → preparedStuckRemaining=0; §7 documenta
  el CLI), no script ad-hoc) · fb-168 (smoke guard — restart re-escopeado 09-06, fila #13
  del §7) · fb-169 (smart_restart con stale-check + sin resume) · fb-172
  (fallo de continuación fb-46) · fb-143/144/145 (race-liveness — **R8 EN
  MAIN `a3ecfb7`**). Prácticas vinculantes adoptadas (fresh-check pre-restart
  + notificación de reanudación post-restart + continuación tras cada bloque
  + watchdog work-register-idle = trigger).
- **BLOQUE 2 P2 — cola NO-GATEADOS (post-ceremonia; protección anti re-
  despacho — NO redespachar: fb-57 · DI-by-services · GUI-monitor · fb-78 A2
  · fb-37 · fb-33 · fb-167 · fb-132):**
  - **ítem 0 — SYNC REGISTER↔ROADMAP = ESTE bloque (CERRADO por esta lane —
    absorción register-sync 09-07 (IPD builder-172), docs-only, 0 commits,
    LISTO-PARA-COMMIT; absorbe wt-register-sync-builder-150 + wt-ola-landing
    + wt-fb163-fb164-policy — carrier ya en main bd128f4).**
  - **transporte fb-23/69/70/81/83** — **CERRADO-con-dónde (CIERRE FORMAL 09-08 —
    estampa de la decisión de cola del head; sustituye la renovación del reloj,
    vencido 09-08 06:39Z — la clase ya no es transporte, por eso NO se renueva)**:
    veredicto explore-deep 2ffad256 09-06 — el MECANISMO está fijado y operativo:
    lane ② `ec2d405` en main, activada 09-03 20:13Z, sweep 247 ciclos, **0 failed
    hoy auditable en el registro de deliveries (el digest 09-08 confirma 0 failed
    rows actuales)**, 0 pérdidas; la causa de los failed residuales = **CLASE
    CAPACIDAD del pooler, NO transporte** — piezas REALES de la familia cerradas
    en sus lanes: fb-23 dispose-gate `3386f7b` (09-04) · clase O1 `f8ce69a` R4
    (09-05) · R5 `e3db75c` (wave guard/DX) · fb-58 CUBIERTO por `ec2d405`
    (settle/rotatedTo en delivery.ts + test lane2-settle-rotatedto; residual
    kind-ack/mirror m-2524 → observacional, clase rotaciones) — la observación
    residual se re-lanea como ítem NUEVO «pooler-capacity» (abajo).
  - **«pooler-capacity / reserva de keys» — NUEVO (OBSERVACIONAL; re-lane del
    residual de transporte, estampa 09-08)** — la observación residual de la
    clase CAPACIDAD: garantizar un colchón de keys para que el pool no caiga a 0
    usable (capacity/owner top-up/reserva de keys) · vincula **fb-75/39 gate de
    billing — el pendiente real de la clase capacidad** (fb-75 gate billingDown
    — **NOTA CIERRE FORMAL 09-09 (register-sync)**: piezas aterrizadas en la
    ola/ceremonia 09-07 — pool-health gate pre-dispatch O1 `0ee5a26` (09-07
    13:11) + pooler master `5fc59b5` + HALT LPC `7c6d3376`; el RECORD QD fb-75
    sigue EN-ESTUDIO — última verificación QH#10 09-08: watch QD activo,
    cierre del record = verificación QD del fix) · owner
    top-up; R3 · NO re-trabajar el pipeline delivery (ec2d405 ya en main y
    operando) — next: internal-programming-head.
  - **fb-253 (higiene programática de deliveries — markDelivery CLI; record QH
    m-3271, 09-08) — CERRADO 09-09** (cadena `5ab20ea` CLI + `a60cb4d` adenda
    hosts retirados; drenaje --apply EXPRESO del host m-3019/m-3022 →
    preparedStuckRemaining=0; el CLI y su uso NO se duplican aquí — ya
    documentados en §7) — CERRADO.
  - **fb-56** (interrupted-post/canary-kill — re-drive + FASE0) · **O2 nudge**
    (lane fbd-nudge-o2 LPC `8e03c04d` — ceremonia 09-07; base foldeada
    `0e2e735`; estado verificado 09-09: ver §5) · **zombie rule pooler** (gap 403→errorClass en probeInvalidKeys;
    pooler master cubre parcial: `8da7363` tombstone P2 + `094cbf8`
    PROBE-FAILED marker) · **m-423** (rotación host PARTIAL — archive corto;
    settle del sidecar; R10 tocó los seams de archive) · **fb-32** (refinamiento
    residual del guard tras el fix `91bc5a8`) · **qi-silence m-2347** (clase
    watchdog qi-silence — datapoint m-2347 a verificar con QD) · **fb-75** (gate
    billingDown — **NOTA CIERRE FORMAL 09-09**: piezas aterrizadas ola 09-07 —
    O1 `0ee5a26` + pooler `5fc59b5` + HALT LPC; el RECORD QD fb-75 sigue
    en-estudio (QH#10 09-08 — ver ítem «pooler-capacity»).

- **POST-DAG — cola nueva (DAG del IPH):**
  - **DI-by-services CERRADO (73f60d9, deploy canary 11:17Z — MISIÓN 8/8)**:
    muerte TOTAL del binder register → holders baseline service-first (P1 0
    ctx.provide; md5 CUT-4 `5b548545` intacto; suite 724/702/0/22 EXACTA);
    dept-as-plugin DESBLOQUEADO.
  - **F6 (ancla recursión D-Q2) — CERRADO-con-fix (006919c, canary 12:32:33Z)**:
    no muestrear inspector cuyo managerId sea inspector QD, o desvío a workers
    NO-QD pasados N niveles — fix runtime en el emitter (m-2170 del QH).
  - **fb-60 (infra-veracidad — propagación de aserciones en withTempStateDir) —
    CERRADO (549fdfb + 6b33664; lane 09-02 builder + seguidor)**: regresión del
    de-flake lane 4 (8dcfc47d) — el `return` en el finally del helper PISA la
    excepción del try (assert.fail tragado → 0-fails falso). Fix
    `return`→`break` + guard test de propagación (invoke.test.js:1021-1033 +
    :1162-1182) + seguidor builder-23 (3/3 fixes + cosmética); el fix DEJA VER
    fallos reales antes enmascarados (188 E2 count frágil del skill mirror, 373
    conflation de la notificación pacing en el helper del test) + el flake M-6
    SMOKE (362) — suite re-cerrada 726/704/0/22 5/5 (0-fails VERDADEROS); QH
    resuelto (verificación independiente).
  - **fb-50 (calibración M-A** capacidad efectiva + completion-reserve) ·
    **fb-51/52 (glob literal-segment false-negative + guard aritmética)** —
    **CERRADO (batch 5ada8ac, canary 15:37:49Z PASS)**: fb-50 knob
    `health.contextCompletionReserve` 262144 aplicado en cordis.patch.yml
    (:125-133/:616; default 0 = legacy); fb-51 anchorGlobPattern en el archivo
    runtime del tool (fijado sha256 02e62ca4…/d3940b54…; bundle SIN el código
    glob — greps 0/5 chunks; port upstream → §3); fb-52 guard aritmética.
  - **feedback-nudge (opción B**, waterfall tools/post-execute — ROADMAP 09-01) —
    **CERRADO (77ca2de, canary 17:11:10Z PASS — LIVE)**: handler
    `tools/post-execute` (tools.ts:912; solo isError → 1 nudge plugin/notice,
    opción A descartada, dedup 1b) + línea inline en guard-denials dept_exec
    (:1313) y dept_zstd_read (:1381) + guía 1c en agent.cordis.yml worker/head;
    suite 732/710/0/22 (+3 tests 568/569/570); reviewer PASS 8/8; CUT-4 y zonas
    F6/fb-53 intactas; 0 deps.
  - **GUI modo monitoreo (owner 09-01) — CERRADO (2026-09-04 — job
    gui-monitor-mode: entrega builder-33 add98365, tests 5/5, REVIEW PASS
    a2c1fe68, job doc decisión owner «SÍ (cerrada — NO reabrir)»,
    0 cambios server, route-lock 6 intacto)**: scoping CERRADO 09-02
    (reports/explore-deep/2026-09-02-gui-monitor-scoping-e2134a39.md) — el
    harness NO expone la
    presencia org al client-inject (solo sesiones propias vía WS/SSE); la GUI no
    tiene identidad de viewer (fence no-auth; session.prompt callable) →
    «composer oculto solo-a-no-host» = upstream/auth (NO plugin-alcanzable);
    opciones org-side recomendadas: B1 presencia org (endpoint
    /deepartments/presence/list + tab, ~0.5-1d) + A1 modo monitoreo GLOBAL
    (composer bloqueado server-side, ~1-2d); A2 (auth/roles) = upstream.
    Ejecutado el modo solo-UI global (composer oculto vía `[data-composer-seat]`
    + poll 5s presence/get + aplicación inmediata tras presence/set — index.tsx
    +127/-1). Job doc versionado:
    docs/departments/internal-programming/jobs/gui-monitor-mode.md
    (decisión «SÍ (cerrada — NO reabrir)»). Detalle en §3.
  - **higiene**: reports-move HECHO (09-02, copy al árbol .dsh/reports) +
    **higiene AMPLIA CERRADA (builder-4 09-02, reporte
    reports/builder/2026-09-02-higiene-amplia-4d92dad5.md)**: 19 archivos + 3
    dirs (≈7.2 MB) eliminados con los 3 criterios (temporal/scratch · 0 citas ·
    sin secretos); PENDIENTE-5 CERRADO-CONSERVAR (.hyg-scratch completo — fx1/
    fx2 fixtures citados + f6-suite-run.log/f6-helper-check.mjs de HOY citados
    por f6-review); PENDIENTE-4 conservado in-situ (scan-sleep.mjs citados como
    probes forenses m22); dir huérfano reports LOCALIZADO = .dsh/reports del
    workspace (3 stragglers: tool-goal-retiro.md CITADO por quality en tree
    equivocado — conservar/no mover; lane1-hardening401.md duplicado idéntico;
    -progress.md huérfano); **8 pendientes D-1..D-8 resueltos por el head:
    TODOS CONSERVAR** (D-1 evidencia citada file:line [precedente congelación NO
    aplicado sin lane de docs] · D-2 scripts/ tooling citado · D-3 .scratch raíz
    [pooler-test-run1.log citado por quality] · D-4 .scratch-m22 raíz familia m22
    · D-5 mover scan-sleep.mjs = lane de docs · D-6 .dsh/reports workspace legacy
    no tocar · D-7 logs 01-sep candidatos futuros · D-8 tmp/ incl. port-harness-
    fb51 HOY activo [§3]) + limpieza .tmp-*
    quality (builder-2 09-02: BLOQUEADA por fb-64 — corroboración EN VIVO;
    → **DECISIÓN QH 09-02**: **2 FROZEN evidencia fb-9** (`.tmp-qi20-defa5d61`
    + `.tmp-explore-deep-64ecf16d` — este último CORREGIDO por el QH: mi
    builder-2 lo marcó STALE, es AMBIGUO/evidencia) + **6 STALE autorizados**
    (reviewer-session, reviewer-164, reviewer-349, qi8-610f,
    explore-deep-session, explore-deep-tools) → limpiar SOLO esos 6 cuando los
    roots lo habiliten (fb-64); respetar además `.inspect/repro-reasoning.mjs`
    y `.inspect/repro-config.mjs` en cualquier higiene amplia).
  - **fb-61 (Bug A SOURCE GATE, test-only) — CERRADO (2f35cab, sin restart)**:
    flake #399 reproducido (ticks daemon solapados intervalMs:50 → doble alert →
    doble append no-atómico) → intervalMs 2000 + residual M-6 SMOKE #365
    (waitFor durable); #559 = B5-GHOST sano; suite 732/710/0/22 4/4; reviewer
    PASS 7/7. Fixes de raíz (atomicidad appends/ledger) → fb-68.
  - **fb-62+fb-53 (token-guard dept_exec) — CERRADO (5c4153a, canary 19:08:04Z
    PASS — LIVE)**: fb-62 «rm -rf /» fuera de denylist substring + helper
    isRmRfRootWipe (destino raíz COMPLETA; scoped rm -rf ALLOWED); fb-53 regex
    deptExecIsPathWord extendida (separador final/close-glue; paths reales
    DENIED intacto); suite 734/712/0/22 (+2 tests B2); reviewer PASS 7/7;
    surface frozen 311 respetado; CUT-4/presets intactos.
  - **fb-63/fb-66/fb-67 (familia toolset) — CERRADO (6feff49, docs puras;
    QH resuelto 3/3)**: reviewer.md +4 (edit DELIBERADAMENTE ausente — read-only
    por diseño, correcciones solo en review); builder.md +3 (no hay pwd nativo →
    probe vía dept_exec); fb-66 = head write-only intencional (freeze código
    HEAD_BASE_TOOLS invoke.ts:2348 — cambio = decisión owner). 0 cambios de
    declaración de tools; 0 re-freeze. Scoping: reports/explore-deep/2026-09-02-
    fb63-toolset-reviewer-scoping-b7f2c3f5.md.
  - **fb-56 (clase interrupted-post/canary-kill — gestionada con re-drive +
    FASE0)** — en cola. · **fb-58 (prepared-stuck — datapoints QH 09-02: ola 3/3
    confirmaciones m-2518/2519/2520 prepared→nunca delivered + rotación IPH
    kind-ack m-2518/m-2520 no contados como confirmación por el mirror m-2524) —
    CUBIERTO por la lane ② `ec2d405` (settle/rotatedTo en delivery.ts + test
    lane2-settle-rotatedto; fb-132 `fe5cab4` + `68384de` drenan prepared en
    runtime; 2ª mitad CERRADA 09-07) — fuera de la cola abierta; el
    candidato kind-ack como «confirmación explícita»
    queda OBSERVACIONAL bajo la clase rotaciones (m-423), no transporte.
    Población prepared-stale 09-08 (m-3034/m-3037 a f4595b15, destinatario
    RETIRADO) RESUELTA por supersede/delivered — WATCH C2 m-3265 (m-3034
    delivered al host vivo 671b6ac5 14:26:27Z · m-3037 cubierto por el
    supersede m-3040 terminal+delivered · residuales = historia append-only
    NO-accionable); higiene = lane fb-253 CERRADO 09-09 (CLI `5ab20ea` +
    `a60cb4d`; drenaje --apply host m-3019/m-3022 → preparedStuckRemaining=0),
    NO script ad-hoc (ver §1 ítem).
  - **fb-64 (execRoots + stateDir READ-ONLY — corroborado EN VIVO por builder-2
    09-02; aditivo, QH sin riesgo fb-55) — SCOPING/DISGNÓSTICO EN CURSO
    (explore-deep-4 09-02)**: discrepancia a diagnosticar: el código declara
    incluir stateDir en allowedRoots (tools.ts:964-990, HOTFIX 0.2.2-1) pero el
    deny runtime sobre /root/.deepartments persiste; define casos de uso mínimos
    (feedback.jsonl, zstd archives), opciones aditivas + riesgo de tests,
    y si habilita la limpieza de los 6 STALE + copia canónica 2 FROZEN.
  - **fb-65 (bajo — ask_user_question con owner ausente) — CERRADO (`35a267e`)**:
    opciones A+C — guard owner-absent orienta a PENDIENTE-OWNER (preserva
    contrato regex) + guidance wakepack rama absent; suite 734/712/0/22.
  - **fb-68 (medio/fallo — atomicidad post-errors src-side: appendPostErrorDeduped
    dedupe no atómico dshd-health:767-775 + MessagesStore.append ids duplicados
    dshd-core/messages.ts:501-528) — CERRADO (`a00e8de`)**: fixes de raíz del
    DIAG fb-61 — id-mint atómico (messages.ts) + FIFO serializer + dedupe
    check-append-advance (dshd-health); suite 738/716/0/22 (+4 tests races).
  - **LANE DEL INCIDENTE 09-03 (cadena IPH, secuencial — UN lane a la vez) —
    CERRADA (sync 09-06; clase delivery CERRADA 09-04, ROADMAP 09-04)**:
    ① **clasificador 401-invalid: DESPLEGADO 2x (09-03 18:23 73d8922 + 18:46
    hotfix 402 0a9cdc7 — ambos canary PASS; lib live)**: sweep convergió
    (oc-8/9/11/12 quota-blocked hasta 09-23..28), completion real 200,
    **oc-10 FUERA por hot-block** (billingBlocked, invalid:true; luego
    tombstone monthly-100) → **LATCH JUBILADO (09-03)** (el gate-clean
    MANUAL RETIRADO; clasificador + age-check por código absorben su
    función) → ② **delivery lane commits 1-4 — ATERRIZADOS (09-03
    `ec2d405`, reviewer PASS 9/9: age-check R1 + re-drive no-boot-only +
    fb-79 backoff + fb-58 settle/rotatedTo + O1 retire-grace + umbrales
    §7.5) + ②-bis (`0103bde` 09-03, reviewer PASS 8/8: G2 settle no-wake +
    mission-queue drain seed) + fold-ins 09-04 (7d5bb70 fb-116/117 ·
    91bc5a8 micro-fixes · 0e2e735 tramo 3 O4/nudge · 3386f7b O1-EXT fb-23 ·
    c19cde4 wake-seam fb-130/131)** →
    ③ **stable :3080 aterrizado (09-03, sentinela twin + auto-index RAG
    desactivado — `9deb11f`)**.
  - **settings revert (provider→opencode-zen con Go vivo)** — coordinar con IPH
    (bandeja owner abierta). · **job-runs primitiva** — en cola IPD.
  - **familia transporte (fb-23/69/70/81/83 — send abort pre-dispatch sin
    persistencia; clase AMPLIADA de mensajería a tools de OPERACIÓN (bash),
    consolidado en notas fb-81) — ABIERTA (REAPERTURA POR RELOJ — veredicto
    explore-deep 2ffad256, 09-06; criterio formal pendiente)**: **fb-23
    dispose-gate CERRADO (`3386f7b` O1-EXT 09-04 — commit REAL de la familia,
    verificado)** · **clase O1 aborts sin detalle → R4 CERRADO (`f8ce69a`
    09-05: write-ahead tool-intents.jsonl + razón durable
    interruption/cancel/churn/read-only — fb-69/70/81/126/133 — commit REAL de
    la familia, verificado)** · **R5 CERRADO (`e3db75c`: guard FPs
    fb-138/142/135 + memo DX fb-88/114 — wave guard/DX, NO es evidencia de
    cierre de transporte; se aclara para no mantener un cierre falso) + fb-82
    R10 CERRADO (`3224713`)** · **fb-83 (4º abort bash) cubierto por la clase
    R4/O1** · **fb-58 CUBIERTO por la lane ② `ec2d405` (settle/rotatedTo en
    delivery.ts + test lane2-settle-rotatedto; evidencia runtime: settle a
    terminal de m-2208…m-2233 el 09-06) — fuera de la cola abierta; residual
    kind-ack/mirror m-2524 → OBSERVACIONAL bajo la clase rotaciones (m-423)** ·
    **R1 CERRADO (absorbido por `ec2d405` — dshd-health index.ts
    `rotationStaleMs`: WARNING con stale NO bloquea)**. **Cierre formal de
    familia fb-69/70/81/m-425 = lane ② (`ec2d405`, activada 09-03 20:13Z) + 48h
    de 0 failed — NO cumplido** (9 failed in-window 09-05 11:30-14:34Z + 14
    post-window 09-06 05:49-06:39Z; TODAS recuperadas/settled — 0 pérdidas;
    causa = CLASE CAPACIDAD del pooler: pool 0-usable, oc-13 429, única usable
    real oc-6 — señal fresca; la clase transporte opera correcto: sweep 247
    ciclos, 0 failed hoy). **Reloj renovado: 48h desde el último failed
    09-06 06:39:41Z → vence 09-08 06:39Z**; contabilidad por CLASE (excluir
    failed por pooler-capacity con señal fresca — clase capacidad cubierta por
    HALT m-2333 + M2 fixes). **Nueva lane sugerida (OBSERVACIONAL):
    «pooler-capacity / reserva de keys»** (owner top-up; R3) — garantizar un
    colchón de keys para que el pool no caiga a 0 usable; NO re-trabajar el
    pipeline delivery (ec2d405 ya en main y operando).
  - **fb-78 A1+A2+A3 (post-restart: re-aplicación smokes vía API + lane)** —
    **A1 CERRADO (09-03, lane builder-2 PASS; reporte
    reports/builder/2026-09-03-smokearchive-hideset-api-d7fe08ee.md)**: los 4
    ids (291b7fa4/d051ef54/b979e1db/bad24e6c) en archivedSessionIds del
    workspace.json vivo (grep líneas 1614-1617, hunk único +4; diff post =
    SOLO ese hunk, keyPooler-state intacto) vía **API canónica
    (POST /api/workspace.archiveSession — fb-82**; la lane previa de
    builder-36 fue edit directo → perdido en reseed, causa raíz documentada);
    sesiones reales verificadas; re-call idempotente; restart NO necesario;
    0 commits/0 edits. **A2 CERRADO (09-04: `939e942` org.offlineReap
    ignition enabled — owner 09-04; restart canary 20:49:48Z, knob ACTIVO,
    census live OK, acceptance 1-5 completo, NRestarts=7 en el ledger §7)** ·
    **A3 (post-restart: re-aplicación smokes vía API + lane) pendiente**.
  - **WIP f61b3d0 (leftover fb-78/gui/grant — builder-17, plan «reset mixto →
    re-split») — ABSORBIDO (2026-09-04, Path A explore-deep-6 2492062d)**:
    f61b3d0 es ancestro directo de la cadena verificada
    (→6e3936c→906506d→1247c32→7d5bb70); 100% contenido vivo en el árbol
    (11/13 blobs idénticos + 2 extendidos conservando fb-78); re-split MOOT
    (reescribiría parents de 4 commits verificados — invalida
    reviews/refreezes/parity); Path A aprobado (2026-09-04, explore-deep-6
    2492062d): el plan «reset mixto → re-split» queda REEMPLAZADO — pendientes
    de gestión: .bak stablegrant PENDIENTE-OWNER · gui-monitor-mode cerrado ·
    fb-78 A2 offlineReap ignition ENABLED (owner 09-04 — `939e942`;
    supersede el default OFF de la policy m-228). Análisis:
    reports/explore-deep/2026-09-04-reorg-wip-f61b3d0-2492062d.md
    (0 edits/0 commits — read-only).
  - **fb-64 RESUELTO-verificado (W-3 af4757c — STORES-MAP.md; probes fresh:
    tools.ts:1393 raw.add(stateDir) incluye stateDir; deny
    /root/.deepartments = workspace by-design, no stateDir; QD q-i-20 no
    re-abre)** · GUI monitor job gui-monitor-mode CERRADO (2026-09-04).
- **CERRADOS en esta cola (no pedir de nuevo):** M4 (system-idle),
  M-A (context-threshold + dept_head_rotate), PACING (peak/valle),
  M-5 (misión-sin-inicio), M-6 (main-red), M-7 (mission-queue),
  fb-43 (restart-registry), fb-39 gate (hardening 401 — 66399ad + pooler
  7248a55), fb-27 (turn/end-error notify — 04f8c31), materializePost cold
  re-spawn (b2ecb45), pulse-digest (c59e1ab), MEMO NORM (c59e1ab + docs RD),
  **fb-28** (37e9315 + QH close), **de-flake W6/BugA + fb-30** (8dcfc47),
  **fb-46 watchdog work-register-idle** (ee0effd), **fb-47 mejoras de sistema**
  (a5a27a7), **0.2.1 P6** (81ef5cd), **0.2.2 P1+P4** (9cda995), **fb-55**
  (5210682), **0.2.3a/b/c** (e8222af/dc9f79a/48cea9f — MISIÓN 7/8),
  **fb-57 CERRADO-con-fix** (250d4d4 dsh-key-pooler — canary 09:33:59Z PASS) ·
  **fb-59 CERRADO-con-fix** (15198b3 dsh-key-pooler — trace: bug latente del
  pooler, NO regresión 0.2.3) · **fb-61** (2f35cab) · **fb-62+53** (5c4153a) ·
  **fb-63/66/67** (6feff49) · **fb-65** (35a267e) · **fb-68** (a00e8de) ·
  **lane ② + ②-bis delivery** (ec2d405/0103bde — clase delivery CERRADA 09-04)
  · **fold-ins 09-04** (7d5bb70/91bc5a8/0e2e735/3386f7b/c19cde4) ·
  **pool-grading M1** (47a8f34) · **fb-78 A2 offlineReap** (939e942, owner
  09-04) · **fb-37** (7c1c424 — job-def §3 optional) · **fb-33** (00572b6) ·
  **fb-64 verificado** (af4757c/9fd0d47) · **waves 09-05 R1-R10/W1-W7**
  (11ca2bb..fe5cab4 — R4 aborts/O1, R5 DX/guards, R6 suite-guard, R7
  toolset/mirrors, R8 liveness fb-143/144/145, R9 spawn fb-29/35/121, R10
  workspace fb-82, WFD no-wake/PEAK, P-LATCH fb-154/155/157, fb-167, fb-132)
  · **fb-27 §7=9 ledger** (cierre 09-06, docs 562d994 — ítem distinto del
  fb-27 notify 04f8c31).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · F-HIGH (630a59c) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) · M3
(f159eda) · D5 (b239b4a) · P1 (448697b) · release 0.1.0 (efd579b) · PASO 1-3 +
tools SB1-4 + presets SB6 + boot Z7 (decoupling HITO 3 — f28c719) · M-5
(f3ec445) · M-6 (79da4f2) · fb-29 (4695145) · VALLE bloque A/B/C (0dbf645 /
b2ecb45 / c59e1ab) · hardening-401 (66399ad + 7248a55) · fb-27 (04f8c31) ·
lane ② delivery (ec2d405 + ②-bis 0103bde — clase delivery CERRADA 09-04) ·
fold-ins 09-04 (7d5bb70/91bc5a8/0e2e735/3386f7b/c19cde4) · pool-grading M1
(47a8f34) · fb-78 A2 offlineReap (939e942) · waves 09-05 R1-R10/W1-W7
(11ca2bb..fe5cab4 — R8 fb-143/144/145 · R9 fb-29/35/121 · R10 fb-82 ·
fb-167 watchdog · fb-132 gate/wake-seam settle · P-LATCH fb-154/155/157).
Fase modular 0.2.x = solo BACKLOG/owner (§3/§5).

## 3. PENDIENTE-OWNER (decisiones — estado al 09-09)

- **GUI modo monitoreo (owner 09-01) — CERRADO (2026-09-04)**: decisión owner
  «SÍ (cerrada — NO reabrir)» registrada en el job doc (docs/departments/
  internal-programming/jobs/gui-monitor-mode.md) — SÍ (composer global solo-UI,
  0 cambios server) · NO tab presencia org (feature (b) descartada) · NO
  per-viewer host-only (upstream) · hardening server-side posterior
  documentado. Entregado: builder-33 add98365, tests 5/5, REVIEW PASS a2c1fe68,
  route-lock 6 intacto. Las opciones org-side A1+B1 y A2 (upstream) quedan
  documentadas en el scoping 09-02 — el job NO se reabre.
- **fb-66 (head sin edit) — write-only intencional DECLARADO (resuelto por
  diseño; cambio de HEAD_BASE_TOOLS invoke.ts:2348 = decisión owner si algún día
  se quiere edit para el head)**.
- **port upstream fb-51 (PR deepseek-harness `packages/fs/tool-fs-search`)** —
  go-ahead del owner; safety copy del fix en tmp/port-harness-fb51-ca5df751/
  (workspace IPD, hashes verificados); **DECISIONES AUTÓNOMAS 09-06 (owner
  ausente)**: señalización GitHub Discussions PRIMARIA + branch portador en
  fork + hot-patch local + rebase search-core P2 — thread/branch preparados
  para REVISIÓN del host antes de publicar; **push-day POST-CEREMONIA 09-07**
  (owner); acción del HOST (clone/PR/rebuild del monorepo — no construible
  desde los roots del lane).
- **billing top-up CRÍTICO → GESTIONADO 09-03 + AHORA RELEVANTE (09-05/09-06)**:
  oc-6 = **key NUEVA del owner (OPENCODE_GO_KEY_6 / ws6, instalada 09-06 —
  la única elegible, weekly real 10→25% invisible al pool: bypass directo
  providers hermanos + medición /usage degradada, m-2327)**; oc-13/14 (key_14
  P1-op) blocked→**09-07 00:00Z** (resets → ~3 usable); oc-8/9/11/12 tombstone
  monthly-100; **fallback DS DISABLED (owner 09-06: la cuenta oficial necesita
  top-up)** — tope de capacidad = oc-6 hasta el reset 09-07; top-up real sigue
  sin decisión (freeze previsible si el 10→25% de oc-6 sube).
- **DECISIONES OWNER 09-08 PARA LA SYNC (m-3268, host 671b6ac5; m-3282)** —
  **rotación de key → NO** (owner aceptó el riesgo; el corpus se excluye igual
  en el restart — fb-241 cierra con nota «rotación declinada» + criterio corpus
  cumplido: counts=0 post-rebuild) · **top-up → NO** + **palanca DS oficial con
  saldo = EMERGENCIA owner** (no es la ruta activa; ver §4 DS-fallback NOTA) ·
  **rc.1-vs-rc.2 → ESPERAR rc.2** (TEMA A RD: rc.1 viable bajo condiciones pero
  sin mejoras urgentes; alpha 0.1.5-alpha.1 Ses-V3 breaking; node v22; rc.1
  gate declinado/diferido) · **stable → no** · **ventana → solo q-i-118 + ruta
  estable** · **pool 46/74/74 mensual + DS-fallback nota** (anotadas en §4 y
  en la entrada 09-08).
- **:3080 + stable-update (25 releases pendientes al 09-09 — monitor 09-09:
  dshmarket 1.21.2→1.45.1 [25] + smooth-stream 0.3.4→0.6.0 [6]; 19 al 09-08)**
  — actualización estable
  pendiente de decisión/programación (ver veredicto RD alpha.4; HOLD 0.1.1-rc.2
  documentado en ROADMAP 09-01).
- **settings revert (provider→opencode-zen con Go vivo) — PREGUNTA PARKEADA
  (owner ausente 09-03; presentar a la vuelta)**: el pooler rutea por
  dsh-key-pooler con oc-6 real live — pendiente de clarificar alcance (¿volver
  el Settings pane al provider opencode-zen?) y coordinar con IPH. Sin acción
  mientras no se aclare (no asumir — norma owner ausente).
- **0.1.2 — DECIDIDO (owner 09-03): OPCIÓN A — WIP+main hasta verde** (el IPD
  aterriza la migración session-surface 0.1.2 rc.1 — tests ya re-freezados;
  main a verde sin salto de versión). **Vanilla** (probar la versión limpia del
  rc) — después del aterrizaje. (El rojo del main por el WIP fue detectado por
  el watchdog system-health; cierra con el landing.) **HOLD 0.1.1-rc.2
  FORMALIZADO (owner 09-05)**: sin rc/alpha (el fix de la regresión alpha.1 NO
  aterrizó; ERESOLVE peers «trap ^0.1.1-rc.0») — la propuesta 0.1.2-rc.1 quedó
  CERRADA; gate 0.1.2-rc.1 reforzado (trace + canary + ecosistema).
- **glm-fallback vía OpenRouter → DESCARTADO (owner 09-01)** — la flota sigue
  100% DS; el veredicto de fondo (ruta opencode-go es el cuello, no la key)
  queda como conocimiento del RD (reports/researcher/2026-09-01-consolidated-
  telemetry-glm-retest.md).
- **top-up ws10/oc-6 → NO por ahora (owner 09-01) — SUPERSEDED (09-05/09-06)**:
  decisión válida entonces; el estado 09-06 la supera (pool pequeño y
  volátil, oc-6 única elegible, top-up AHORA RELEVANTE — ver §4; resets
  09-07 00:00Z recuperan oc-13/14).
- **stable 3080 — SUPERSEDED (owner 09-03): lane AUTORIZADA** — el IPH procede
  con el perfil stable (/opt/dsh/.dsh) al terminar ①+② de la lane del incidente;
  **RAG-stable sentinel aplica**: antes del primer boot del stable, (i)
  desactivar auto-index RAG O (ii) actualizar su plugin a 0.4.0-rc.1+denylist.
  (El "NO TOCAR" 09-01 quedó reemplazado por esta autorización.)
- **D-Q2 → mantener cadencia event-driven (owner 09-01)** — sin cap diario.
- **RAG-stable SENTINEL-PENDIENTE (condicional, dormido)** — si/если se toca
  /opt/dsh/.dsh: (i) desactivar auto-index RAG O (ii) actualizar su plugin a
  0.4.0-rc.1+denylist ANTES del primer boot. Hoy NO se toca (constraint).
- **keys Go adicionales (compra opcional owner: RD 7-8 keys $70-80/mes)** —
  sin decisión; no urgente (capacidad ok por ahora).
- **¿remoto GitHub para dsh-key-pooler?** — repo local-only (7248a55); pregunta
  open menor al owner.
- **profiles/web scaffold inerte en dev (IPH 09-03, lane settings-revert)** —
  ¿intencional o eliminar? Decisión pendiente del owner; sin acción hasta
  veredicto (elección de limpieza → IPD).
- **bak `cordis.patch.yml.bak-20260903-131645-stablegrant` en
  packages/dshd-core (IPH 09-03)** — backup pre-grant (148 líneas); owner
  decide commit/limpieza al tocar la rama fb-78/grant (el grant en sí está
  VIVO y owner-aprobado: missionExecRoots [/opt/dsh/.dsh] — NO es residuo).
- **brief diario 09-04 (RD m-782/783) — LISTO PARA PRESENTAR al owner** —
  ruta ABSOLUTA /root/.deepartments/departments/research/reports/daily-news/2026-09-04.md
  (top: GPT-6 Astra «era AGI» con
  trade-off monitorabilidad; Qwen3.8-Max-0902, MAI-Transcribe-2, NVIDIA
  PAIR, Tesla Cybercab Austin); de-dup verificado (+17 URLs, +5 topics);
  presentar a la vuelta junto con el estado post-crisis y fb-75.
- **fb-136 — footprint stale del top-level de /root/.deepartments (archivo
  OPCIONAL → decisión OWNER; w-3/af4757c + STORES-MAP.md §1)**: el footprint
  stale (`health-heartbeat.json`/`posts.json`/`config-presets` 09-03, clase
  fb-134 CERRADO) queda SIN archivar hasta decisión owner; NO unificar el
  `.dsh/reports` legacy sin decisión (D-6 «no-tocar»).
- **fb-285 (QD, 09-09 — limpieza GLOBAL del ghost-store /root/.deepartments) —
  ABIERTO, PENDIENTE-OWNER** (hermana global de fb-136/fb-284; record QD):
  debris huérfano de una instalación previa en la raíz del workspace
  (hosts/messages/posts/restart-registry/health-alerts*/secrets//departments —
  mtimes 08-23→09-06; el store vivo es /.deepartments; familia fb-134) —
  decisión OWNER: **purgar completo vs anotar/archivar**; cualquier purga debe
  revisar/neutralizar el dir `secrets/` sin exponer credenciales (convención
  fb-16, no borrar a ciegas). Ver ENTRADA 09-09.
- CERRADOS: publish 0.1.0 (efd579b) · D5 · P1 · tool-goal retirado · API key
  DeepSeek (fallback real) · restart 05:23:31Z (owner: ignorar — watch si
  reaparecen; restart-registry lo deja visible) · cause restarts 08-31
  explicada (switch glm + reversión).
- **A-harness (p2-hygiene lane) — DECISIÓN HOST TOMADA (m-3107, ceremonia
  09-07 — APLICAR la topología upstream deepseek-harness-fb51 `d347e703`)**:
  fase 1 A-harness ATERRIZADA (`27142eb` port patches + apply + re-freeze
  `a27daaf`, ventana 09-07) · **2ª ventana A-harness fb51 CERRADA-VERIFICADA**
  (topología `d347e703` · p2-hygiene ce467a44 · wt-harness-p2hygiene-a 271
  archivos; evidencia: preflight 328fed2e + re-run host + canary 18:57Z ·
  `--check` 14/14 · smoke 12/12 · manifest triple ✓ · apply-required 0 ·
  web-fetch-http excluido) — next: host (commit de cierre) / owner (fb-51 push-day) — CERRADA-VERIFICADA.
- **QI-48-A (extensión QI-48) — owner** (post-ceremonia; ver LANDING 09-06).
- **canary fase 2 — post-ceremonia** (smoke aislado + cross-check q-i-61).
- **restart re-escopeado (09-06) — pendientes HOST**: re-enable
  canaryAgentCheck (quitar el TEMP) · canary restart contra M1 (x-opencode-
  session header) · verificación /v1/responses muse-spark (post-M1) ·
  rotaciones IPH/QH a la junción post-ceremonia (m-2175/2178).
- **protocolo host anti-parálisis ADOPTADO (q-i-60, 09-06)** — END con
  reanudación programada + welcome con orden de arranque + check anti-
  parálisis en wakes/hitos (sub-norma welcome en §7 por fb-184 LPC).
- **RESTART §7 de fb-27 — ledger cerrado** (9 sancionados + artefacto429 +
  0 no-planificados; cierre 09-06) — el §7 NO necesita más decisiones; el
  crashStreak 9 = artefacto clase 402 (salto 5→9 señalado).

## 4. CAPACIDAD (al 09-08)

- **Pool LIVE 09-08 (m-3282 + ROADMAP 09-08; stateFile POST-revive)**:
  **4 KEYS ACTIVAS — totalKeys 4 · eligibleKeys 4** (oc-6 · oc-13 · oc-14 ·
  **oc-15 REVIVED** invalid:false, invalidSince 0 — fix del prefijo `sk-` en
  el drop-in confirmado en el boot; restart doble-deber 18:57Z canary PASS) ·
  pool **46/74/74% mensual + 41.8% oc-15** (lectura restart) · **DS-fallback
  NOTA (m-3268)**: la palanca DS oficial con SALDO (api.deepseek.com) queda
  como EMERGENCIA owner (top-up NO; la cuenta tiene saldo pero la ruta activa
  es el pool Go).
- Pool LIVE 09-06 (stateFile + GET /__keypool/status 14:54Z):
  **oc-6 = key NUEVA del owner (ws6; única ELEGIBLE — sirve el 100% del
  tráfico; weekly 0% = último valor conocido por probeDegraded, NO fresco:
  uso real 10→25%, m-2327)** · **oc-13/14 = key_14 (P1-op, fast add owner
  09-05, canary 11:33:17Z PASS) blocked→09-07 00:00Z** (weekly 100%) ·
  oc-8/9/11/12 tombstone (monthly-100) · oc-10 muerta (billingBlocked).
  **Resets 09-07 00:00Z → ~3 usable.**
- **P-POOL LIVE (2c2bdda 09-05)**: probeDegraded durable «% UNKNOWN»
  no-alerting (availability models 200) — el % ciego ya no spamea; el
  `weekly 0%` de oc-6 es sub-medición (ruta /usage del upstream cuelga).
  **LANE A usage-poll NO desplegada** (working tree pooler, 0 commits) →
  nadie mide el % weekly en runtime (fix ALTA m-2327; entra con la lane A de
  la ceremonia).
- **HALT (m-2333, wt-pool-hmax-p1 LPC `7c6d3376`)**: gate HALT-only en
  scanPoolerCapacity + resolvePoolerDispatchBlock; knobs code-default 20/10
  (perfil live SIN tocar); 2 outages CERTAIN conservadas (owner confirmado).
  **Pooler master: `094cbf8` R1 zombie PROBE-FAILED · `2c2bdda` P-POOL +
  fb-13/77 · `5fc59b5` fb-75 billingDown gate · `8da7363` tombstone P2 ·
  `bbc0067`/`c83948f`/`b28143a` key-policy p1-p4 (fail-stop 503
  KeyPoolerHalted).**
- LATCH JUBILADO 09-03 (gate-clean MANUAL retirado; clasificador + age-check
  por código absorben) · DS-fallback a api.deepseek.com **DISABLED (owner
  09-06** — la cuenta oficial necesita top-up) · fall-through 401/429
  (bb22b20) · gate poolerGateEnabled (hardening 66399ad — live).
- Lección 09-03 (vigente): **usage 200 ≠ chat-auth** — el clasificador
  401-invalid formaliza 401/billing vs 429/monthly.
- Límites conocidos: **pool pequeño y volátil (1 usable hasta el reset
  09-07**; oc-6 real es la única key; el resto quota/auth) · **key_14
  (oc-13/14) comparte cuenta opencode — verificar workspace real ws6 vs
  ws13/14** (labels del pool = placeholders, m-2327 FIX 3) · **top-up de
  keys = AHORA RELEVANTE** (al 09-01 «varias keys con buena capacidad» era el
  espejismo del health-check viejo; la verdad = 1 key real → o top-up o
  pipeline pegada al techo).
- Watchdogs M1 activos + M-4/M-5/M-6/M-7 + context-threshold (M-A) +
  pooler-capacity (hardening 66399ad + M1 gradings 47a8f34) + fb-167
  settlement-wait (3db2617) + fb-184 v2 (LPC) + qi-silence (M1.1) —
  auto-observación completa del runtime.

## 5. BACKLOG

- **O2 del QD (09-03, dirigido a host/runtime) — nudge spliced a posts RETIRED
  sobre abort de vida → dead-letter — CERRADO-foldeado (0e2e735 fold-ins
  tramo 3 09-04**: dead-letter retired, life-abort, dedup + fix guard
  dual-surface getSessionEvents en nudgeTurnOf) + **lane fbd-nudge-o2
  LISTO-PARA-COMMIT (`8e03c04d`, ceremonia 09-07)** (ambos tocan tools.ts) —
  **ESTADO VERIFICADO 09-09 (register-sync)**: la id `8e03c04d` NO resuelve
  como objeto git; la SEMÁNTICA del nudge dead-letter O2 (CANCEL/vida-abort
  no-nudgeable + post retirado nunca nudged) YA está en main vía `0e2e735`
  (fold 09-04) + `692bcaa` (09-07, ANCESTRO de HEAD; tools.ts post-execute +
  test o2-nudge-deadletter) · wt-fbd-nudge-o2 conserva un delta SIN commitear
  sobre base 562d994 (tools.ts +27/-6, invoke.test.js +21,
  r4-abort-intents.test.js +35) que es una VARIANTE propia (NUDGE_LIFE_ABORT_
  CLASSES autónomo, NO presente en main) → lo que falta = VERIFY del host del
  solape wt-vs-main (¿el delta añade algo post-`692bcaa` o es variante
  superseded?) + COMMIT del remanente o CERRAR la lane como absorbida.
  + **mejora watchdog: mission-stalled (10-min) dispara falso positivo sobre
  entregas no-wake-gated por diseño (records bajo de feedback al QH drenan al
  próximo wake — caso m-410/fb-89) — CERRADA (WFD `4d03b43` 09-05: franja-
  aware watchdog/nudge — no-wake exclusion + PEAK no-op)**.
- **POST-MORTEM PEAK 09-09 (D-Q6) ADOPTADO (owner→host, m-3813) — 4 ítems
  estructurales colados**: (1) GATE DURO franja en spawns/despachos (override
  anotado), (3) re-ancla cron digests quality-daily/daily-ai-news fuera de PEAK
  (coordinar con QD/RD + espejo dsh-key-pooler.peakWindows), (4) formalizar
  restarts-solo-VALLE (excepción crash), (2) drain automático cola→VALLE —
  orden 1→3→4→2; ver ROADMAP. Fuentes: reporte
  /home/esuarez/projects/deepartments/.dsh/reports/quality/2026-09-09-
  postmortem-peak.md + cordis.patch.yml org.pacing.
- **Rotación host m-423 PARTIAL (veredicto QD 09-03) — EN COLA (P2)**: el
  archive de dept_sleep corta ~85 líneas de la cola zombie final (incl.
  m-426 delivered post-retirement; acks a host rotado 'prepared') —
  candidato fix IPD (completar archive/settle del sidecar — el R10 `3224713`
  ya tocó los seams de archive con merge guard, el settle del sidecar sigue
  pendiente). · **Residuo live-handle**: builder-2 retired:true en posts.json
  pero running en dept_who — higiene IPD (revisar/retirar handle).
- **Hueco zombie rule (dsh-key-pooler — OBSERVADO lane clasificador 401 09-03,
  PARCIALMENTE cubierto en pooler master)**: probe 403-region-gate sobre key
  clase-401 sobrescribe errorClass→'403' en probeInvalidKeys — candidato lane
  pooler post-deploy; pooler master ya cubre clases próximas (`8da7363`
  tombstone P2 + `094cbf8` R1 PROBE-FAILED marker durable + key-policy p1-p4
  con fail-stop) — el gap 403→errorClass queda como candidato residual (P2).
  (Mejora aparte: falso positivo dept_exec en grep con patrón /models\) →
  reportada al QD por el
  builder.)
- ~~flake 1b.1~~ ~~m-64~~ ~~fb-8~~ — DONE · ~~comentario stale dshd-health~~
  DONE (PR-1) · ~~fb-25/26/27/28~~ — fb-25 (2b5a370) ✓ / fb-26 práctica ✓ /
  fb-27 ✓ (04f8c31) / fb-28 ✓ CERRADO (37e9315 + QH close) · ~~fb-30~~ INVESTIGADO (diseño-no-bug;
  catch-up durable = lane 4) · ~~fb-29~~ IMPLEMENTADO (4695145 + lane B b2ecb45)
  · ~~fb-32~~ CERRADO-con-fix (91bc5a8 09-04: guard FP dept_exec regex sed/awk
  — fb-32/106, caso builder-5; refinamiento residual del detector en P2) · ~~fb-39/40/41/42/43/44/45/46/47/48~~ — fb-39 ✓
  (hardening) · fb-40/41 convención adoptada (verificación QD) · fb-42
  watch-class · fb-43 ✓ (0dbf645) · fb-44 ✓ LANDED R7 (researcher sin edit —
  presets/departments/research/researcher.md declara la ausencia deliberada de
  `edit` — read-only por diseño fb-63/66 — + patrón read→write full-rewrite en
  presets y docs/departments/research/jobs/daily-ai-news.md + tabla mirrors en
  SOURCES.md) · fb-45/46/47/48 prácticas/normas QD+host (ver ROADMAP
  09-01) — pendiente de cierre formal por el QD cuando verifiquen/aterricen.
- **MISIÓN TOTAL MODULARITY per Cordis (owner 09-01; **RATIFICADA**)**: north-star
  **P1-P8 ACEPTADO** (definición RD reports/researcher/2026-09-01-cordis-total-
  modularity.md) + **AMPLIACIÓN owner: CADA DEPARTAMENTO = plugin propio
  (dshd-<dept>)** — departamentos como unidades composables/desechables
  (autoescalable/mejorable). **TERMÓMETRO: 09-01 lane 0.2.1 (0dbf... — 81ef5cd):
  P6 NO→SÍ-PARCIAL (~3-4/8 global; tester P6 6 tests + R1 exacto; P1 intacto;
  P3/P4/P8 mejoran)**. Receta 0.2.x: 0.2.1 ✓ (81ef5cd) → 0.2.2 (applyInvoke→
  fábricas-Services + políticas P4 — briefing del IPD) → 0.2.3 (colapsar
  doble-mirror + híbridos; incl. R4 provider→org config, IQ: jobs→spawn-
  Service, gui split, R5 qiDirectiveRate política, register legacy eliminado)
  → 6-7/8 → dept-as-plugin (cierre post-6-7-8). Exit-criterion = P1-P8 medibles
  + P7 a nivel departamento.
- **CANDIDATO runtime/IPD (proceso, QD observación 09-01) — anclaje del muestreo
  D-Q2**: la cadena recursiva se autogenera (cada inspector retirado cae en el
  sample 25% de otro inspector QD — 5 curas hoy, 0.25^k decae pero autoconsume
  muestras del QD); candidatos: (a) tope de profundidad (no muestrear inspector
  cuyo padre inmediato fue QD) o (b) muestreo dirigido a workers NO-QD tras N
  niveles. Post-DAG (junto a mejoras de sistema; diseño de pipeline calidad).
- **PROCESO CONSOLIDADO (QD 09-01, confirmado x2 en job workers del research:
  deepseek-dsh-news-3 + ai-industry-news-4) — propagar jobId/contexto de ronda
  al mensaje del worker en rounds monitor-driven** (sin ello la MEMO NORM no se
  activa — el worker no sabe que es job worker y razona «Finish — ephemeral»).
  Routing: research/IPD (construcción del mensaje del monitor/job runner).
  + **convención fecha UTC** (frontmatter/nombres en UTC, no local — patrón
  +1 día x2 hoy). Post-B (o que el research-head lo tome si lo ve claro).
- **fb-2/fb-3 QD — AGENDADAS** (render dept_sleep en sleep EXITOSO + latencia
  noWake a cabezas dormidas — cola QD, sin ejecutar).
- **F3 — barrido sesiones worker huérfanas** (Dx1 F3; backlog 0.2.x) ·
  **B6/B7** (revisar obsoletas con A+B) · **rag_index 300s timeout** (cap/
  configurabilidad) · **tsc-drift dsh-tool-web-enhanced** (E1/0.2.x) ·
  **fb-31 hygiene menor** (stale flags, doble build client) · **fb-34**
  verified-at en reports explore-deep · **fb-37 job-def quality-daily
  CERRADO (7c1c424 09-05: §3 session-archive → opcional/targeted-on-demand,
  decisión QD)** · **A4-2 + fb-140 CERRADO (W-1 docs 09-05: VERIFICATION-LADDER §5/§6 — review-worktree isolation + rutas absolutas de reports)** ·
  **fb-24** KB dominio→mirror (R7 3125c16: tablas mirror en SOURCES.md —
  patrón extend-never-duplicate; la formalización KB→mirror global queda
  candidata) · **fb-26** zstd-con-cap práctica ✓ ·
  **fb-33 CERRADO (W-2 00572b6 09-05: preset tests restore-en-finally
  robusto)** · **O3** nota
  en spec 005 §3.4 ✓ (knowledge).
- **core DSH 0.1.2-alpha — WATCH owner + HOLD 0.1.1-rc.2 (owner 09-05)**
  (peers trap `^0.1.1-rc.0` en
  dsh-deepartments/smart-restart/tool-web-enhanced → ERESOLVE si se mueve el
  host; dshmarket 1.43.0 dev ✓; smooth-stream 0.6.0 a disco — live-load
  próximo arranque).
- **Versions**: dshmarket 1.43.0 dev ✓ (live — restart canary 09-06) ·
  smooth-stream 0.6.0 a disco (live-load próximo arranque) · npm
  dsh-deepartments 0.1.0 publicado ✓.

## 6. SINERGIA

Flujos head↔head operativos (m-422): IPD→RD, QD→RD, RD proactivo (tech-watch +
análisis de fallos). M3 los institucionaliza en docs/skill. Hoy: QD→IPH
(programmatic requests fb-46/47), IPH→QD (aviso verificación fb-27/28).

## 7. PACING — política operativa (peak/valle)

> Disciplina operativa de la franja (owner m-PACING, 2026-08-28 — pacing/coste;
> espejo de la sección "Pacing (peak/valley franja)" del skill
> deepartments-workflow + de la doc de `org.pacing.*` en cordis.patch.yml).
> La franja es un HECHO UTC puro (fórmula espejo del dsh-key-pooler marcada por
> comentario en ambos repos): **PEAK ⇔ weekday(UTC) Mon-Fri ∧ hora-UTC ∈
> {1,2,3,6,7,8,9}**, con buffer de bordes 30 min por defecto (bias de
> inicio/fin del request).

- **En PEAK los NUEVOS despachos del host a departamentos NO se lanzan**; los
  in-flight continúan (un worker a mitad de misión, una misión ya asignada —
  nunca se aborta). El host no abre misiones nuevas hasta el aviso de VALLE.
- **NO hay cola de diferidos nueva**: la cola de diferidos = los PENDIENTES del
  WORK-REGISTER (esta misma cola, la única fuente de verdad). En PEAK los ítems
  se acumulan exactamente como hoy; NADA se mueve a otra estructura.
- **El aviso de VALLE es el trigger de reanudación**: el daemon notifica al
  host una vez por transición (canal durable + interrupt — como el alert de
  salud): entrando PEAK → «pausa de nuevos despachos»; entrando VALLE →
  «reanuda; despachos diferidos: N» (N = pendientes legibles de este
  WORK-REGISTER; si no legible, sin conteo). En «reanuda» el host reabre el
  pipeline desde los pendientes (prioridad normal).
- **NORMA DE CONTINUACIÓN (fb-46, 2026-09-01 — host)** — nunca quieto con
  trabajo por hacer: al CERRAR un bloque, re-explorar el WORK-REGISTER y
  continuar con los items NO gateados (solo los gateados esperan al owner);
  VALLE = ventana de drenaje (no parada); PEAK = única pausa intencional; si un
  no-gateado depende de uno gateado → esperar justificándolo explícitamente.
  Respaldada estructuralmente por el watchdog work-register-idle (§1).
- **Los heads ven la franja en su wake** (sección `## Pacing (franja)` del pack
  y en `dept_wake_snapshot`) y siguen la misma disciplina para SUS nuevos
  despachos de workers (difieren un spawn nuevo en PEAK; lo ya asignado
  corre).
- **Primer arranque del daemon**: solo registra la franja actual, NO avisa
  (ventana de entrada ya pasada; el pack lleva la franja actual — decisión
  documentada en dshd-health). Dedupe: una vez por transición (key
  `pacing-transition` en el shared ledger; baseline durable pacing-state.json).
- **Knobs**: `org.pacing.*` en cordis.patch.yml — `enabled` (default true;
  `false` = comportamiento legacy: sin sección en el pack, sin avisos),
  `peakWindows.weekday` [1..5], `peakWindows.hours` [1,2,3,6,7,8,9],
  `peakBufferMs` 1800000. **PRÓXIMOS CAMBIOS (documentados)**: cualquier
  retune de la ventana se coordina y se espeja en dsh-key-pooler
  (`fallback.peakWindows`/`peakBufferMs`) — ambos repos declaran el MISMO
  límite (horas {1,2,3,6,7,8,9} ≡ 01:00-04:00 ∪ 06:00-10:00 con el mismo
  buffer) y deben mantenerse en sync.
- **SUB-NORMA ANTI-FB-163/171 (handshake de responsabilidad — 2026-09-06,
  digest QD junción; complementa la NORMA DE CONTINUACIÓN fb-46 de esta
  sección)**: NUNCA descartar un watchdog/signal sin verificación del
  counterpart — cifra + fuente (fb-45) del estado REAL antes de descartar. El
  informed-dismissal sin evidencia verificada (patrón fb-163/171, 5ª vez el
  09-05: «items en DAG post-PREP» asumido, 83 no-gated parados) NO silencia el
  re-alert: la carga de la prueba vuelve al que descarta. En acuerdos
  multiparte, registrar el handshake de responsabilidad (quién verifica qué,
  con qué cifra+fuente) ANTES de cerrar la señal.
- **SUB-NORMA ANTI-FB-164 (gate-breadth — 2026-09-06, digest QD junción)**:
  distinguir ZONA-GATED vs PIPELINE-GATED en el register: un lock de zona
  (p.ej. el main-red con lock de la zona CUT4) NO gatea el pipeline completo —
  el gate correcto es solo la zona+push. Antes de dismiss/espera, verificar el
  estado del red/bloqueo real (ledger main-red, health-alerts, zona CUT4) —
  el 09-05 el lock de zona paró 83 no-gated cuando el gate correcto era solo
  la zona+push.
- **SUB-NORMA WELCOME CON DESPACHO (fb-184, item 5 — protocolo del host;
  template canónico m-2040/2041)**: la bienvenida a un fresh (rotación OK,
  journal seed verified) termina con ORDEN DE ARRANQUE — handoff de estado +
  **VENTANA ACTUAL (VALLE = drenaje, no parada; fb-46)** + lanes/items
  despachables AHORA (del census non-gated/`next:`) + «¿cuál arrancas?»
  (BOOT-QUIET roto por el primer turno = el despacho, no la espera). Backstop
  estructural: el watchdog despierta al head idle con sus items `next:<head>`
  como primer trabajo (system-wait, item 6 de fb-184) — el drenaje no depende
  de la iniciativa del host en cada rotación.
- **NORMA REPO-FACTS = WORKER (fb-209 — criterio QH, 2026-09-07; se estampa a
  resuelto cuando aterriza)**: los HEADS obtienen hechos de git/repo a través
  de un worker (dept_exec) — los heads NO ejecutan git directamente; el patrón
  repo-facts=worker es la norma (ver micro-lane head-tooling para
  `dept_repo_state` candidata). Aplicación práctica: un head que necesita
  verificar un commit/branch/árbol pide el dato a un worker IPD (o lo recibe
  en un reporte), nunca corre `git` él mismo.
- **FB-253 (mark-delivery CLI — builder-203, 2026-09-08)**: `scripts/mark-delivery-cli.mjs`
  is now the host-run hygiene tool for the prepared-stale class (fb-117/137):
  it LISTs and APPLY-settles stale `prepared`/`failed` delivery-sidecar rows
  whose recipient is a RETIRED post (append-only `terminal` via dshd-core
  `markDelivery`; criterion mirrors `settleRetiredPostDeliveries` incl. the
  ALTO-1 rebind guard; idempotent). Host usage (repo root, built lib):
  `node scripts/mark-delivery-cli.mjs --list --stateDir /.deepartments`
  (dry probe, default) → `--apply` (append ONE `terminal` per candidate pair) →
  optional `--recipient <id>` scope; `--apply --dry-run` for a writing preview
  that writes nothing. Tests: `test/mark-delivery-cli.test.js` (fixtures only —
  never the live stateDir).
- **NORMA EMERGENTE — WORKTREE-FUENTE ABSORBIDO (guard fb-20; candidata del QD
  D-Q3-IPH — a register; estilo de esta sección)**: el literal LIMPIO del guard
  fb-20 («worktree LIMPIO — cero cambios sin commitear») NO prevé remover un
  worktree-fuente cuyo delta YA está commiteado en main: el wt absorbido está
  legítimamente SUCIO (retiene la copia del delta ya absorbido + artefactos de
  runs) pero su absorción es PROBADA. CRITERIO ADOPTADO (caso O2-ALIGN): con
  absorción verificada hunk-por-hunk contra el commit en main (regiones
  idénticas + tests byte-iguales; diff full-file restante = base-drift legítimo)
  se autoriza `git worktree remove --force` + `prune`; remoción verificada
  (ausente del worktree list); pérdida aceptable = copia del delta + artefactos.
  Referencias: lane O2-ALIGN `9420964` ·
  /root/.deepartments/departments/internal-programming/reports/builder/2026-09-09-cleanup-wt-fbd-nudge-o2-631e8329.md
  y ...-exec-23a00303.md.
