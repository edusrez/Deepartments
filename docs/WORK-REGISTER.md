# WORK-REGISTER — trabajo pendiente

> **LANDING 2026-09-23 (host Asistente `30ed2af0`, wake 118)** — **FILAS 18 + 3c
> DESPLEGADAS AL ÁRBOL SERVIDO + HUECO DE 77,98 h ADJUDICADO + `474` CERRADO**
> (detalle: `.dsh/reports/host/2026-09-23-deploy-rows18-3c-y-adjudicacion-hueco.md`
> y ROADMAP 09-23). (1) **Desplegado y verificado POR IDENTIDAD** (md5 == POST
> declarado en los dos ficheros; 25.462 ficheros comparados y solo esos dos
> cambiados; cero `.rej`; canario PASS; proceso arrancado DESPUÉS del parche):
> `ROW 18` `2443ac0c→539094cd` · `ROW 3c` `a182162d→f3b4e74d`. Efecto medido con
> Host y 3 Heads retenidos: 626→24 filas, 112.213→5.383 B, 517→24 proyecciones,
> 28,2→7,8 ms CPU/item. (2) **Hallazgo que invalidó una conclusión previa**: los
> symlinks del perfil se **re-apuntaron al árbol el 09-22 21:16:32** — 3 min
> DESPUÉS de la medición que concluyó «3c = NO-OP»; hoy **240/249** paquetes se
> sirven del árbol y los 9 que van al global no los toca ninguna fila ⇒ **3c no
> era NO-OP** y quedó verificada **por conducta** (`SEARCH_FAILED` →
> `grep: path not found:`). **fb-2488**. (3) **`474` CERRADO** con `version = 3`
> DENTRO del header vivo (peer 0.1.5-rc.2). (4) **Hueco de 77,98 h ADJUDICADO:
> capacidad, NO caída** (proceso vivo 978/1728/1728 líneas, mismo PID; tombstone
> `monthly-100` → pool a 0 claves del 18-09 10:25 al 21-09 12:18:54, y el hueco
> termina 96 s después; 35 `mission-stalled` + 34 `pooler-capacity`).
> **COLA QUE ESTO ABRE (VALLE, no PEAK)**: **fb-2489** (el oráculo del lane
> `sidebarfix1` se auto-invalida al desplegar: derivar el brazo pristine del
> **árbol de control**, hoy 6/6 con `DSH_DEV_TREE=/opt/dsh/trees/control-0.1.5-rc.2-pristine`)
> · **fb-2488** (falta un DETECTOR del re-link del perfil) · **fb-2490** (test
> `THE ALERT` del sampler, verde solo cuando la máquina está mal) · **fb-2487**
> (QH: el `ts` del encabezado deriva hasta +119 min del `ts` durable).
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
> CERRADO-anotado 09-09** (limpieza GLOBAL ghost-store /root/.deepartments —
> decisión host ANOTAR-no-purgar: 19 mv `.stale-2026-09-09-fb285-*` host-plane —
> ver ítem §3) · **fb-234 CERRADO-absorbido**
> (su next: host CUBIERTO por 6397fb5 + cadena VALLE — ver ítem §1) ·
> **fb-75 nota de cierre formal** (gate billingDown aterrizado O1 `0ee5a26` +
> pooler `5fc59b5` + HALT LPC `7c6d3376` — el record QD fb-75 permanece
> EN-ESTUDIO, watch QH#10 09-08; ver ítem §1 pooler-capacity) · **§3
> stable-profile 19 → 25 releases al 09-09** (monitor 09-09: dshmarket
> 1.21.2→1.45.1 + smooth-stream 0.3.4→0.6.0) · **O2-nudge fbd-nudge-o2
> `8e03c04d` LISTO-PARA-COMMIT pendiente del host** (verify+commit; ver §5).
> **ENTRADA 09-09 — CIERRE DE OLA (tarde/noche; IPD builder-227, lane register-sync
> cierre 09-09; docs-only, 0 commits, LISTO-PARA-COMMIT — verify + add EXPLÍCITO de
> docs/WORK-REGISTER.md + docs/ROADMAP.md)** — fase de cierre de la jornada 09-09
> absorbida (la mañana YA registrada en `c431b72` — NO se re-absorbe): **`6e156a9`
> docs(register) NORMA worktree-fuente absorbido (§7, guard fb-20; candidata QD
> D-Q3-IPH) — CERRADO** · **`8718ed1` docs POST-MORTEM PEAK ADOPTADO (D-Q6, owner→host
> m-3813; WORK-REGISTER §5 ítem + ROADMAP 09-09 tail) — CERRADO** · **`90a06dc` mirror
> PERMISOS HOST (cordis.patch.yml:86-88 — PUSH PERMANENTE + DELEGACIÓN TOTAL +
> persistencia; owner 09-09; lane IPH item 1) — CERRADO** + SOURCES.md RD (`1504a2b`
> — ajeno al bundle, absorbido por el host) · **O2-ALIGN `9420964` ACTIVADO** (plugin
> add perfil dev; canary 14:08:18Z PASS: capas dsh-deepartments l.638 + dsh-key-pooler
> l.738; /v1/models 200; pooler ok 4/4) — CERRADO · **Pooler P2/P2b DEPLOY** (repo
> dsh-key-pooler, HEAD `d22afcf` + `7596881` ancestro; verificado post-canary:
> lib==proceso, guard P2b lib/proxy.js:1337-1338, region-gate P2 :1208/:1250; tests
> sweep.test.js:361-367/:395-410) — CERRADO · **Hot-patch fb-251** (pi-ai overflow.js +
> compaction-basic:803 — node_modules, NO repo; cargado con el canary 14:08:18Z;
> reviewer PASS) — CERRADO con FLAG de persistencia (se pierde en reinstall; candidato
> upstream register, ver cola) · **Ítem 1 permisos host COMPLETO** (mirror `90a06dc` +
> preset local /opt/dsh/.dsh-dev/.agent-presets/deepartments/agent.cordis.yml «Owner
> permissions (permanent)» l.101-112; backup
> agent.cordis.yml.bak-permissions-20260909-141540) · **Ítem 4 purga projcache
> CERRADO-COMO-DIFERIDO** (decisión host, adenda al cierre de ola): «purga
> session_projcache.json PENDIENTE de ventana natural de mantenimiento (perfil dev
> parado — opción b del hallazgo; la política restarts-solo-VALLE del post-mortem
> adoptado la refuerza) — 13 ids retirados (lista en reporte
> /root/.deepartments/departments/internal-programming/reports/builder/2026-09-09-
> projcache-purge-9bd29c54.md), backup
> /opt/dsh/.dsh-dev/storages/session_projcache.json.bak-projcache-purge-20260909-
> 141354 como evidencia, daemon-autoritativo republica el fichero (in-process delete
> = opción a si algún día se hace en vivo)» · **fb-293/294/295 DX path-not-found**
> (familia fb-292/269/135 — hint de descubrimiento consolidado; lane guard/harness
> candidata). **KPI 09-09: abiertos/cerrados/balance = 17/1/+16** (criterio: store vivo
> /.deepartments/feedback.jsonl, snapshot 09-09 ~14:22Z — ABIERTOS = creados 09-09 UTC
> con estado no-terminal (17 de los 18 creados hoy; fb-302 duplicado excluido);
> CERRADOS = terminales con updatedAt 09-09 UTC en el store vivo (1 = fb-302
> duplicado); balance = 17 − 1 = +16; NOTA DE CRITERIO: el store evicta terminales al
> archive — feedback-archive.jsonl suma 15 terminales updatedAt 09-09 (7 resuelto + 8
> duplicado, 05:56–13:49Z), mayoría cierres de la MAÑANA ya absorbidos en `c431b72`
> (fb-272/fb-284) y la colisión de id fb-285/fb-286 post-CORTE impide un dedupe
> cross-store fiable → cerrados-del-día con archive (≈16, balance ≈+1) NO fiable).
> **COLA NUEVA (4 ítems breves — ver §5):** (i) quality-daily no-fire 08:00Z 09-09 =
> idempotency-skip «quality-daily-8 ya corriendo» (worker retirado, stamp stale en
> job-runs) → lane higiene job-runs (clase O3-b/auto-heal no-fire) · (ii) fb-300/fb-301
> rematerialización post-smart_restart NO reconstituye toolset (worker Y head, restart
> 14:08:18Z; fb-301 transitorio confirmado por el head; contrato fb-18 «toolset
> esperado por rol») → lane host-plane/IPD register/preset-pass · (iii) wording
> CRITICAL RULE 2 + Workflow step 4 del preset host (ask_user_question
> «Non-negotiable» vs DELEGACIÓN TOTAL `90a06dc`) → lane BAJA staged próxima rotación
> (deploy-time) · (iv) hot-patch fb-251 persistencia upstream (register).
> **ENTRADA 09-09 — CIERRE DEL BLOQUE 1 (IPD builder-230, lane register-sync cierre
> bloque 1 09-09; docs-only, 0 commits, LISTO-PARA-COMMIT — verify + add EXPLÍCITO de
> docs/WORK-REGISTER.md + docs/ROADMAP.md)** — cierre del BLOQUE 1 (VALLE) absorbido:
> las 2 lanes IPD del bloque CERRADAS + decisiones host reconciliadas + fb-51 §1/§3
> (STALE) + notas QD; NO re-absorbe mañana/ola (ya en `c431b72` + `adfccc3`):
> **pooler-capacity / reserva de keys → CERRADO-en-entrega (LISTO-PARA-COMMIT)** —
> implementación builder-228 run `09ebe790` (reporte reports/builder/2026-09-09-
> pooler-capacity-09ebe790.md) + gate reviewer-118 PASS (reporte reports/reviewer/
> 2026-09-09-pooler-capacity-review-2f59ba26.md): reserve SOFT durable — UN campo
> `reserve` en PoolSnapshot con `ReserveRecord.level` low/critical (naming conforme
> decisión host 4/scope head, dictamen reviewer) · `diagnoseReserve` PURA pool.ts:1144+
> · defaults `RESERVE_DEFAULT_*` 0.25/25/10 configurables (config.ts) · `refreshReserve`
> + seam único poolSnapshotWithHalt proxy.ts:955 · status GET /__keypool/status ·
> cadencia usage-poll · logs `[key-pooler] RESERVE` + `onReserveAlert` · 0 cambios
> eligible/select/servicio · build tsc OK + npm test 213/213 (0 regresiones). Repo
> dsh-key-pooler HEAD `d22afcf`. Consumidor deepartments (gate) DIFERIDO a junción
> host-move rc.2 (cierre formal fb-75). Verificación opcional post-deploy: estado live
> (2 keys 86/87% mensual) debería emitir reserve LOW · **re-ancla cron digests +
> higiene job-runs → CERRADA por ambas partes** (lane builder-229 `dfe6e38a`; §5 cola
> (i) ya CERRADO — NO duplicado): re-ancla quality-daily `'0 11 * * *'` (11:00Z) +
> daily-ai-news `'30 11 * * *'` (11:30Z), fuera de PEAK efectivo 00:30-10:30Z
> (org.pacing + espejo pooler); no-fire 09-09 = idempotencia correcta (intento
> redundante vs worker LIVE de ronda EXITOSA — hipótesis stamp-stale REFUTADA); O3-b
> NO-fix; QH decisión owner: NO re-run quality-daily 09-09 (digest EXISTE m-3601 —
> re-run habría sobreescrito outbox); RD cerró cuerpo daily-ai-news.md (11:30 GMT/UTC)
> + sync dominios (fb-286/297) · **DECISIONES DEL HOST (bloque 1, DELEGACIÓN TOTAL
> owner 09-09) RECONCILIADAS**: rc.1 family HOLD rc.2 confirmado (sin ejecución) ·
> stable-web constraint mantenida esta jornada · verdict D-Q2 CLEAN (builder-227) ·
> fb-285 scope en bloque 2 con inventario · pooler umbrales 0.25/25/10 soft ADOPTADOS
> · **fb-51 RECONCILIADO §1/§3 (STALE)**: D1 PUBLICADO 09-06 (owner presente) +
> revisión host PASS (Discussion #5826 verificada live por el host) → §1 ítem fb-51
> (DIFERIDO/no-publicar) = STALE → CERRADO-en-hechos (§1) + §3 port ACTUALIZADO;
> RESTO fb-51 = owner-grade SOLO (fork re-push opcional · issue interno #NN · merge
> upstream vía instancia interna DeepSeek) → PENDIENTE-OWNER (sin inventar #NN) ·
> **fb-306** (QD bajo/mejora — snapshot pre-rotation PARTIAL: incluir result+turn/end;
> lane runtime) — UNA línea, ref record durable del backlog · **fb-307** (QD
> bajo/mejora — misdiagnóstico «no-fire/stamp stale» propagado desde handoff del host
> ~14:23Z; práctica: verificar contra digest/outbox ANTES de declarar no-fire) — ref ·
> **NOTAS QD (2, del D-Q2 builder-228 CLEAN, inspector-159/7937f168)**: (a) ítem
> metadatos archive tools[] — 2º datapoint (builder-227 §3.4 + builder-228): el campo
> tools[] del retire record omite `edit` pese a usos reales (5 y 35) → consumidores
> del archive NO deben usar tools[] como inventario fiable de tools usadas; (b)
> truncation journal — 4º caso D-Q2 consecutivo (223/224/227/228, corta en memo-call
> seq 71078; clase x8 del día; zstd fuente de verdad) + sugerencia opcional no urgente
> (incluir reason del turn/end en el journal) · **§1 «pooler-capacity» CERRADO-en-
> entrega** (DAG — ítem cerrado como entregado; gate consumidor diferido; ver su ítem
> §1). **Sin referencias abiertas «next: internal-programming-head» de las 2 lanes**
> tras esta entrada (verificado).
> **ENTRADA 09-09 — CIERRE DE JORNADA (IPD, lane register-sync de bloque; docs-only,
> 0 commits, LISTO-PARA-COMMIT — verify + add EXPLÍCITO de docs/WORK-REGISTER.md +
> docs/ROADMAP.md)** — cierre final de la jornada 09-09 absorbido (la mañana `c431b72`,
> el CIERRE DE OLA y el CIERRE DEL BLOQUE 1 NO se re-absorben; landings → lane/worker):
> **LANE RED export-parity** `14d7bee` (fix de main-RED; builder-234 e20bb76c;
> reviewer-120 PASS m-4067 / reporte `51bd7238`) — causa raíz `55361e4` (fb-235
> attribution del predecesor) rompió la paridad de exports; aritmética exacta
> **325→327** (reporte builder-234 m-4056: 2 exports runtime nuevos por el star
> re-export bridge; scanTurnErrorCaptures = MOVE count-neutral; interfaces type-only
> sin runtime) → `14d7bee` restaura main VERDE (lock 3/3, canon 524/15/22 intacto) ·
> **fb-308 «journal-writer finalizeSessionLog (4 dim.)»** `bab3ca9` (builder-236
> b6b25157; reviewer-121 PASS `2c44c81c`) — las 4 dimensiones: (1) crash-safe tail
> (header end_seq/end_time EXACTO vs zstd real post-dispose), (2) journal SIN cota
> (seal aditivo final:true/turn_end_reason/zstd_final_seq — CUT-4/zstd/archive
> INTOCADOS), (3) re-emisión snapshot (nombre único por sesión — dimensión 3
> RE-EMITIDA vía fb-311/m-4049, aterrizada en este commit; el record fb-311 queda
> abierto como mejora de proceso «transmitida ≠ procesada»), (4) finalize session-log
> (plano host, hooks H1/H2/H3 — retirePost/rotación host/sleep de head); desglose
> exacto en explore-deep-73 `3d93f627` + builder-236; **record QH ya enviado con
> evidencia post-commit** (fb-308 resuelto 09-09 20:37Z, host m-4123) ·
> **fb-306/N1 rotation-close dept_sleep SUCCESS** `fe9d388` (builder-237 364bc3bb;
> reviewer-122 PASS `82c4c17e`; 8 archivos, 0 zstd) — C1 (settle 'settled' sin
> post-error: isHostRotationClosed PURE module-private) + C2 (seal aditivo
> sleep_result success(rotation) — presets.ts:667) + C3 (marker durable hosts.json
> oldEntry sleepResult:'success' — session-rotation.ts + registry.ts); fb-306
> RESUELTO 09-09 20:37Z · **GATE DURO franja** (post-mortem PEAK ítem 1) `aba670b` —
> loop: builder-239 `5de54871` **FAIL condicionado** (reviewer-123 `bb61e2c3`: freeze
> fb-266 declAt desincronizado 86→93 por el diff) → fix builder-240 `a34aa0fe` →
> re-gate **PASS** (reviewer-124 `a52b9162`, m-4144) — paso 0c EARLY en los 3 seams
> (runJobForDepartment/spawnWorkerForDepartment/dept_post_create; override anotado +
> ledger pacing-overrides.jsonl; daemons exentos por construcción) · **DRAIN-VALLE**
> (post-mortem PEAK ítem 2) `bf8efa5` (builder-241 99071311; reviewer-125 PASS 7/7,
> m-4157 / `c7ec39ca`) — fan-out notifyPost a heads de pendientes WORK-REGISTER al
> cruzar franja→VALLE → **POST-MORTEM PEAK 4/4 COMPLETO** (1 GATE DURO `aba670b` ·
> 2 DRAIN-VALLE `bf8efa5` · 3 re-ancla digests · 4 restarts-solo-VALLE — 3 y 4 ya
> formalizados antes, ver ROADMAP 09-09) · **fb-300/fb-301 toolset reassertion
> own-layer** `853c12e` (builder-242 2a975be5; reviewer-126 PASS `7d18f18a`, m-4184) —
> clase worker+head (registro/preset-pass post-restart: boot heal + guard ramo-live en
> materializePost; 0 exports nuevos, parity 327); **records QD fb-300/fb-301 CERRADOS
> conjuntamente con evidencia post-commit** → cola §5 (ii) CERRADA con esta entrada ·
> **fb-51 CERRADO DEFINITIVO 09-09 (decisión host m-4149)** — redacción canónica
> sustituida en §1/§3 (ver apartado 2): «fb-51 CERRADO 09-09 por decisión host (fix
> público Discussion #5826; issue #NN opcional; merge upstream no perseguido)»; RESTO
> owner-grade opcional PENDIENTE-OWNER (fork re-push · push-day · merge vía instancia
> interna), SIN #NN inventado · **KPI 09-09 (al cierre de jornada, snapshot store vivo
> 09-10 ~00:55Z)** — 24/13/+11 con el mismo criterio de la entrada previa (ABIERTOS =
> creados 09-09 UTC estado no-terminal excl. duplicados = 24; CERRADOS = terminales
> updatedAt 09-09 en el store vivo = 13 [fb-302/fb-306/fb-308/fb-310/fb-312/fb-313/
> fb-314/fb-316/fb-317/fb-319/fb-320/fb-321/fb-322 — incl. fb-308/fb-306 resueltos
> 20:37Z]; balance = 24−13 = +11; difiere del snapshot 14:22Z de la ola (17/1/+16) por
> los cierres de la tarde/noche; NOTA: el cierre QD de fb-300/fb-301 consta en esta
> ENTRADA (no aún terminal en el store) + archive NO fiable — misma nota del criterio)
> · **NOTA WATCH fb-235: sigue ABIERTO** — cierra con el primer bare-400 post-deploy
> (deploy diferido VALLE largo 09-10; verificación reserve LOW 86/87% del
> pooler-capacity ENCOLADA).
> **ENTRADA 09-10 — ROTACIÓN DE MODELO DEL ORG → `deepseek-flash` (IPD, lane
> model-rotation; changeset atómico LISTO-PARA-COMMIT, 0 commits — commitea el host;
> reanudación post-incidente; **NO se re-absorbe lo ya absorbido** — lo ya registrado en
> las ENTRADAS 09-07→09-09 NO se duplica y la ola de stable-web :3080 se declara NO
> abierta en esta entrada)** — el ORG entero (HOST + heads + workers) corre el id
> NUEVO **`deepseek-flash`** (`opencode-go/deepseek-flash`): **UN solo id MULTIMODAL**
> que sustituye a los DOS legacy (`deepseek-v4-flash` en heads/workers +
> `deepseek-v4-flash-vision-exp` en el host) — los legacy quedan **RETIRED** (siguen
> aceptados como nombre, pero fuera de la config: id nuevo inequívoco) · proveedor
> **SIN tocar** (`opencode-zen` = ruta GO vía pooler :4097 → upstream
> opencode.ai/zen/go/v1; **GO-ONLY**, no está en Zen PAYG) · **`reasoning_effort max`
> INTACTO** en TODAS las entradas (verificado byte a byte en los 3 sitios: settings
> `agent-default-model` + `llm-deepseek`, filas org de los 2 paquetes, y las personas
> desplegadas) · **pricing Go NUEVO**: $0.15/$0.60/$0.003 off-peak · $0.30/$1.20/$0.006
> peak · **Usage $15 meter x4** (docs Go 09-10) · **NOTA F5**: la edición de
> `packages/dshd-orchestration/src/presets.ts` (`WORKER_AGENT_OPTIONS` +
> `HOST_AGENT_OPTIONS` → `deepseek-flash`) es del HOST, **owner-autorizada** y queda
> **NO REVERTIDA** (runtime truth; se describe en el gate post-hoc) · **caveat RD**:
> opencode **#48180/#48093** (HTTP 400 opaco al combinar reasoning_content echo-back +
> reasoning_effort en sesiones multi-turno con tools = **correlación fb-235**) →
> **smoke post-deploy del host** (si 400 → mitigación; si no → datapoint de cierre) ·
> **scope clarification (el scope literal del mandato era INCOMPLETO)**: las
> definiciones de modelo de heads/workers NO viven en el `cordis.patch.yml` raíz sino
> en **`packages/dshd-core/cordis.patch.yml` + su mirror `packages/dshd-core-min/`**
> (row `agentOptions` ×3 + `workerAgentOptions` + `hostAgentOptions`, parity-locked
> por `test/org-config-parity.test.js`) — sin esos 2 ficheros la rotación NO cambia el
> runtime · + los presets base head/worker + 13 ficheros de `presets/departments/**` +
> el **catálogo `settings.yaml`** (clase **fb-42/25**: el id DEBE existir en el
> catálogo del proveedor o la rotación cae en el retrofit phantom-model) + el **twin
> `deepartments-dev-headless`**: sus 2 filas `tool-subagent-test`/`tool-subagent-test-fork`
> (`profiles/deepartments-dev-headless/cordis.patch.yml:33/:42`) llevan
> `model: deepseek-v4-flash-vision-exp` porque su provider es **`deepseek-official`**
> (api.deepseek.com), donde ese id es el nombre PROPIO de la API oficial — quedan
> **INTACTAS por decisión host y FUERA del scope de la rotación** (la rotación es la ruta
> `opencode-zen`) → NO es una rotación incompleta (criterio: `deepseek-flash` en la ruta
> `opencode-zen` para agentes/heads/workers/`agent-default-model`/`probeModel`) · **test-pin
> sync**: los 9
> asserts que pinneaban los literales legacy se sincronizaron al id nuevo (dept_post_create
> / F3 dept_worker_spawn / F4b dept_job_run / fb-6 seam + forensics / R2 fb-42/25 probes
> (a)+(c) / R4 code literals / re-freeze md5 de la zona PRESETS del factory) RESPETANDO
> la semántica de cada test — las fixtures con `stub-coord` y los logs de sesión
> sintéticos NO se tocan · **NOTA INCIDENTE**: el org quedó congelado 11:16→12:52Z por
> **STAGING INCOMPLETO** (settings.yaml con solo `deepseek-flash` mientras el bundle
> deployado seguía pinneado al legacy → «pi-ai provider opencode-zen has no configured
> model deepseek-v4-flash» en cada turno); el host desplegó el fix **canary PASS, boot
> 12:52:46Z** · **PROCEDIMIENTO (wording del host — NO es un extra)**: al re-staging de
> modelos, **retirar + re-materializar las sesiones vivas ES PARTE DEL PROCEDIMIENTO, no
> un extra** — una sesión MATERIALIZADA pre-fix conserva el modelo legacy en su HANDLE
> (el handle no se re-resuelve del config global) → turnos fallidos aunque la resolución
> global ya esté arreglada; **remedio: `dept_worker_retire` + respawn fresh** (la
> re-materialización se lleva el id nuevo) · **auditoría de roster post-deploy SIN
> sesiones stranded** (verificado por el host): las pre-fix ya estaban retiradas
> (builder-247 por IPD; quality-daily-10 / quality-inspector-174 / quality-daily-9
> offline-retired) y los VIVOS son TODOS post-fix (builder-248, daily-ai-news-11,
> quality-inspector-175/176, quality-daily-11; heads respondiendo).
> **DECISIONES HOST 09-10 (5)** — (i) **buffer franja 30 min MANTENIDO** · (ii)
> **stable-web :3080 = LANE IPD PROGRAMADA** — próximo **VALLE** tras la rotación
> VERDE (ola de 25 releases dshmarket **1.21.2→1.45.1** + smooth-stream
> **0.3.4→0.6.0**; sentinel RAG pre-boot auto-index off o 0.4.0-rc.1 + denylist;
> canary) — **NO ejecutar la ola ahora** (esta entrada NO la abre) · (iii) **fb-51 (c)
> vía interna = NO ACTION** · (iv) **franja PEAK/VALLE sin cambio** (espejo del
> pooler; el pricing nuevo NO dispara re-evaluación en esta lane) · (v)
> **GOAT/CommandCode NO se adopta ahora + WATCH** (fin de los 4x de docs/go, anuncio
> post-17-09, WorkBuddy como 3er partner; el smoke GOAT condicional queda PARQUEADO).
> **ENTRADA 09-10 — INCIDENTE DE CONGELACIÓN DEL ORG POR ROTACIÓN DE CATÁLOGO
> SUBTRACTIVA (IPD, lane prevention-docs; docs-only, 0 commits, LISTO-PARA-COMMIT —
> commitea el host; **NO se re-absorbe lo ya absorbido**: la ENTRADA 09-10 de la
> ROTACIÓN DE MODELO (arriba) NO se duplica — esta entrada añade la CLASE, la
> PREVENCIÓN y las lanes abiertas del incidente, y la ola de stable-web :3080
> sigue NO abierta)** — **INCIDENTE**: el org quedó congelado **96-101 min**
> (ventana 11:11:34→12:52:46Z · inicio causal **11:20:58.109Z** · recuperación
> **canary PASS 12:52:43.186Z + boot 12:52:46Z**, bootId 2d06fce7…,
> `recoveryCause "deploy"`) por **CAUSA RAÍZ = escritura LIVE SUBTRACTIVA del
> catálogo de 11:20:58Z** (el `settings.yaml` vivo BORRA `deepseek-v4-flash` y
> `deepseek-v4-flash-vision-exp` del provider `opencode-zen`) **con el bundle
> desplegado AÚN pinneando el legacy** (constantes `WORKER_AGENT_OPTIONS`/
> `HOST_AGENT_OPTIONS` + filas de coordinador) → `pi-ai provider "opencode-zen"
> has no configured model "deepseek-v4-flash"` (`UNKNOWN_MODEL`) en cada turno de
> head/worker (la puerta de admisión del adapter valida POR PETICIÓN; el
> productor del pin sólo cambia con build+`plugin add`+restart) ·
> **VEREDICTO DE CLASE**: **recurrencia AMPLIFICADA de fb-42** — MISMO invariante
> (un pin resuelto por el runtime NO existe en el catálogo vivo del provider) y
> misma firma, con **MECANISMO nuevo** = **subclase C1 «atomicidad staging-live ↔
> deploy»** (el catálogo vivo se vuelve SUBCONJUNTO de los pines desplegados)
> frente a la subclase C0 del 09-01 (pin adelantado al catálogo en un mint) —
> **NO es clase nueva** (registro operativo **fb-332** fallo/alto/abierto
> `related:[fb-42,fb-25,fb-167]`; veredicto QD consolidado 09-10 con 2
> inspectores) · **EVIDENCIA DURA**: primer turno muerto **11:21:13.223Z**
> (builder-247 turn 2, 15 s tras la escritura; el fallo REALMENTE primero es
> quality-daily-10 **11:21:12.984Z**, 239 ms antes, NO registrado en los stores
> centrales) · **101 min de INACTIVIDAD con 0 turnos** de agentes
> (11:21:13Z→12:40:35Z — el único turno del host en la ventana, turn 33
> 12:40:36.046Z, TAMBIÉN falló; auto-bloqueo: reparar exige turnos y la puerta de
> admisión los mataba) · **alerta +92 min** (el post-error de 11:21:13Z se alertó
> a las **12:53:47Z**, y sólo porque el tick corrió post-boot; `health-alerts`
> con 0 filas entre 11:14:34Z y 12:52:46Z = 98 min de ceguera, y `deliveries`
> marcaba `delivered` wakes que NUNCA ejecutaron turno) · **residuo post-fix
> 12:54:13.925Z** (builder-247, handle materializado PRE-fix, vuelve a fallar con
> el fix YA desplegado → remedio manual `dept_worker_retire` + spawn fresh
> builder-248) · **canary 12:52:46Z** (la recuperación la disparó un **nudge
> manual del OWNER 12:41:00.377Z**; ningún watchdog la detectó, y el host fue el
> único actor capaz de reparar por accidente arquitectónico → amplificación de
> **fb-167**) · subregistro de stores (1 de 3 fallos en los stores centrales) y
> escritura live de 12:40:49.718Z NO atribuible en el audit trail ·
> **REMEDIACIÓN**: fix del host con el orden correcto (constantes → 6 ficheros
> live → build → `plugin add` → `smart_restart canary`) y **F5
> owner-autorizada** — ya descritas en la ENTRADA de la rotación, NO
> re-absorbidas aquí · **PREVENCIÓN INSTITUCIONAL (esta lane, docs-only)**:
> `AGENTS.md` **regla 11** (invariante I-MP «pines ⊆ catálogo vivo en TODO
> instante, incluido el estado intermedio de un changeset» + **catálogo
> ADITIVO-FIRST** + re-materialización de handles; la regla-orden «atómico» o
> «live después del deploy» es NECESARIA pero **NO SUFICIENTE** — contraejemplo
> simétrico: la edición subtractiva rompe por ambos órdenes) +
> `docs/VERIFICATION-LADDER.md` **§2.5** (paso TIERED pre-flight
> pines↔catálogo, mecanismo = guard `MPC-PREFLIGHT`, con el criterio P5 del
> **pin resuelto por turno**, nunca la fecha de nacimiento del sessionId) + skill
> `deepartments-workflow` (**ritual de rotación de modelo en 7 fases** con
> **sweep del roster OBLIGATORIO**: retirar + re-materializar handles stranded,
> fb-332) · **LANES ABIERTAS**: **MPC-PREFLIGHT (código, IPD — prioridad ALTA;
> spec QD §4.2 con aceptación A1-A8: enumerador de pines P1-P6 +
> pre-flight bloqueante + write-guard del catálogo subtractivo + puerta de boot
> loud-durable + extensión del probe R2 a create/resume + P5 handles)** ·
> **fb-337 (detección — mejora/alto/abierto, emisor quality-head; watchdog
> `delivery-no-turn-after-N-min` + `plane-no-turn-after-N-min` + audit de
> write-completeness de health-alerts; spec de 302 líneas entregada al IPD,
> **SERIAL** respecto a MPC-PREFLIGHT porque ambas tocan `index.ts` +
> export-parity)** · **REDACTOR (esta entrada — normativa docs-only del
> incidente; el cierre ACOPLADO del assert `test/invoke.test.js:6926` + skill
> viaja como changeset futuro, NO tocado aquí)** — records:
> **fb-332** (clase/handle stranded + apply parcial) · **fb-337** (detección) ·
> **fb-42** (familia; pendiente de anotar la subclase C1) · **fb-167** (SPOF del
> host amplificado).
> **ENTRADA 2026-09-22 — EL DÍA DE LOS COMMITS, EL DEPLOY DE LAS 17:48 Y LO QUE
> QUEDÓ EN VIGOR (IPD `builder-468`, lane `work-register-sync`, docs-only; encargo
> del HOST, `m-1261` 19:45Z)** — **por qué existe esta entrada**: al abrir la lane,
> este registro tenía **mtime 2026-09-21 19:12:11.988Z (116.988 B)** y **0 menciones
> de `2026-09-22`, 0 de `drainedAt`, 0 de `doc-drift`** (medido con `grep -c` antes de
> escribir: 0/0/0) ⇒ la semilla de un relevo era un registro de ayer. **VENTANA DE
> MEDICIÓN de esta entrada: 2026-09-22T20:13Z–20:23Z**; cada cifra con su fuente y su
> instante. **ÁRBOLES DECLARADOS**: `/home/esuarez/projects/deepartments` (HEAD
> `d2da32d`, 20:07:59Z, al cerrar la ventana), `/home/esuarez/projects/dsh-key-pooler`
> (HEAD `1095e4a`), `/home/esuarez/projects/dsh-smart-restart` (HEAD `dbceb31`),
> stateDir **`/.deepartments`**, DEV home **`/opt/dsh/.dsh-dev`**, workspace de la
> lane **`/root/.deepartments/departments/internal-programming`** (⚠️ DOS raíces de
> stateDir en juego: `/.deepartments` es el stateDir del daemon y
> `/root/.deepartments` el árbol del departamento — la trampa está medida, `m-1278`).
> **LOS 6 COMMITS DEL ENCARGO, verificados uno a uno con `git log`/`git show`**:
> `846cf40` **19:25:19** `deepartments` — el guard de pairing de pi-ai queda
> REGISTRADO en el manifiesto (`patches/deepartments-maintenance.tsv`: +1 fila
> `pi-ai-tool-pairing-guard` → `/opt/dsh/trees/departments-dev-0.1.5-rc.2/…/@earendil-works/pi-ai`
> `dist/api/openai-completions.js`, más el patch de 159 líneas) ⇒ **versionado:
> sobrevive a un `dsh upgrade`** · `d4a9358` **19:16:55** `deepartments` — GATE de
> capacidad: el rótulo nombra la causa con **`missing:`/`basis:`/`remedy:`**
> (el `basis:` es `SERVING_PATH_BASIS` = «Go keys (usable = not invalid, not blocked,
> past cooldown) + declared channels (enabled && !halted && past cooldown)»,
> `packages/dshd-health/src/index.ts:5862`; presente también en el bundle compilado,
> `lib/index.js:4101`), **el predicado NO se toca** y el consumo preexistente
> (`delivery.ts:/pool:|at quota|dispatch delayed/i`) se conserva + **el lector
> `officialBlocked` (A)**: el campo queda DECLARADO en el contrato del lector
> (`src/index.ts:5261`) y EXCLUIDO por el predicado único `poolerServingChannels`
> (`:5358`, con `:5287` en la cadena) · `804e87d` **19:17:06** `deepartments` — el
> literal PEAK del test sigue el rótulo nuevo (`test/jobs.test.js`, +4/-1; el
> anti-storm O3-b casa por la familia `[deepartments] pool: …`, que se conserva) ·
> `dbceb31` **19:11:47** **`dsh-smart-restart`** — el sello de `fb-2418`: «the
> outgoing session SEALS instead of blocking — the resume notice names the seat»
> (6 ficheros, +757/-9) · `1095e4a` **19:11:47** **`dsh-key-pooler`** — el comentario
> de `officialBlocked` nombra a su consumidor (`src/proxy.ts:2203-2210`; SOLO
> comentario: +6/-0) · `70e779a` **18:08:34** `deepartments` — el control de
> `POOLER_STATE_FILE` se ancla en su DEFINICIÓN (`dshd-health/src/index.ts:4795`), no
> en el import de `tools.ts` (2 pass/1 fail → 3/0).
> **Y 3 COMMITS MÁS en `deepartments` que el encargo NO listaba** (llegaron después de
> escribirlo; medidos a las 20:23Z): `b4d3701` **19:52:05** (el fallback de rotación
> del host deja traza durable y greppable — `appendRegistryAnomalyRow` con la
> taxonomía de `MUTE_HOST_SENDER`), `dccbb1e` **20:05:34** (la denegación de
> `dept_exec` declara la forma que SÍ admite: `-p` UNA vez con valor LISTA por comas;
> el predicado y la whitelist, intactos) y `d2da32d` **20:07:59** (el inspector del QD
> caza PATRONES de comportamiento por encima de incidentes; petición del owner).
> ⇒ **hoy: `deepartments` 9 commits · `dsh-key-pooler` 3 · `dsh-smart-restart` 3**
> (`git log --since="2026-09-22 00:00"`, medido; HEAD de cada repo declarado arriba).
> **EL DEPLOY DE LAS 17:48 — verificado en journald, no por relato**: 17:48:23
> `[smart-restart] smart_restart: wait: registry already IDLE (0 other sessions
> mid-turn)` · 17:48:27 `Stopping`→`Stopped`→`Started` · 17:48:32 el pooler arranca
> con `channel "commandcode" (enabled) -> https://api.commandcode.ai/provider/v1 ·
> 2 key(s) [cc-2, cc-4] · peer YES` · 17:48:39 `[deepartments] online` ·
> 17:48:45→17:49:03 avisos de resume a las 7 sesiones interrumpidas. **Fila de
> `/.deepartments/restart-registry.jsonl` para ese arranque**: `77d1c8bb` **17:49:39.610Z**
> `cause "deploy"` (precedida por `f0ada726` 17:46:18Z `recovery pre-tick crash
> (streak 14)` y seguida por `e9b80d00` 19:07:49Z `unknown`).
> **Y ANTES del deploy hubo bucle duro — hecho medido, NO causalidad adjudicada**:
> **15 `Started` / 14 `Main process exited`** en 17:31:00→17:45:30, con **56 líneas
> `atomic-write: timed out waiting for the writer lock at …/.credentials.yaml.lock`**
> (todas entre 17:32:39 y 17:44:55, o sea 0 fuera de esa ventana en todo el día) —
> es el hecho que sostiene la lane del lock (`explore-deep-142`, medición, no arreglo).
> **QUÉ QUEDÓ EN VIGOR — cada punto con su evidencia**: **W1** (la API oficial no
> puede entrar al pool) ⇒ `/__keypool/status` leído **20:13:29.524Z**: canal
> `commandcode` `enabled:true` · `officialBlocked:false` · `peer:true` · `ready:true` ·
> `keys:2`; `eligibleKeys 0` · `totalKeys 0`; `lastRotation` = `oc-15` → **ninguna**,
> `monthly-100 deleted`, reset **2026-10-03T12:20:28.154Z** · **W2** (el 400 de cliente
> deja de cargar un canal sano) ⇒ las dos agujas literales están en
> `dsh-key-pooler/lib/config.js` (`DEFAULT_REQUEST_REJECTED_VOCAB`), y en journald
> **112 líneas `answered 400 (request-rejected)` hasta 19:05:46Z y 0 desde el arranque
> de 19:06:38Z** · **W3** (el detector) ⇒ las dos claves de dedupe por modo
> `pooler-capacity:official-api:declared` y `:legacy` presentes en
> `packages/dshd-health/lib/index.js` (**mtime 18:50:30.814Z**), y ese paquete es el
> MISMO que ejecuta el daemon (symlink `profiles/deepartments-dev/node_modules/dshd-health`
> → `packages/dshd-health`) · **W9** (un `dept_feedback_update` sin campo de escritura
> se rechaza) ⇒ `no update field applied` en `src/tools.ts:6152` y en el lib `:5363`,
> con el ancla de runtime `Object.keys(input).length === 0` (`src:6281` / `lib:5501`) ·
> **guard de pairing VIVO** ⇒ líneas `dsh-guard-toolpair`: **0 antes de 19:06:34 y 314
> después de 19:06:38** (primera de todas, 19:07:14), y la firma
> `Messages with role 'tool' must be a response…` **114 en el día con la ÚLTIMA a las
> 19:05:46 y 0 desde 19:06:38** · **spill 7d** ⇒ `/etc/cron.d/dsh-tmp-hygiene`
> (fichero leído): una sola regla,
> `30 4 * * * root find /tmp -maxdepth 1 -type d -name 'dsh-spill-*' -mtime +7 -exec rm -rf {} +`,
> y su propia cabecera declara que DSH no tiene retención propia y que el cron es
> CONTENCIÓN, no arreglo. ⚠️ **NO medí recuento ni bytes de `/tmp/dsh-spill-*`**
> (`dept_exec` deniega `/tmp` como cwd/ruta y `glob` no enumera directorios): **las
> cifras del cron (155 dirs, 2,0G, leídas 09-22) se citan como DECLARADAS por ese
> fichero, no como medición mía**; lo mide el job `server-hygiene`. Disco raíz, leído
> por mí **20:13:29Z: 84% (30G/38G)**.
> **LO QUE EL DEPLOY *NO* CERRÓ (para que nadie lo dé por hecho)**: el campo
> `drainedAt` tiene **0 ocurrencias** en el repo (grep sobre `*.ts`/`*.js`/`*.md`
> fuera de `node_modules`) y el volcado del buzón sigue ocurriendo **al cerrar el
> TURNO, no al cerrar el PASO** (medido por el host en su propio transcript:
> `agent/inbox/spliced` con `removed=1` por mensaje; `m-1237`/`m-1248`) ⇒ la lane del
> drenado (`builder-470`) es la que lo cierra. Y `batchEligibleDeclared` sigue con
> **0 filas en `/.deepartments/gate-decisions.jsonl`** — que es lo CORRECTO por
> diseño (es log-only; su casa es la línea del log `FB467_INSTRUMENTATION_STAMP`,
> que a su vez tiene **0 ocurrencias en el journal del día**): quien lo busque en el
> ledger concluirá «el fix no cargó» teniéndolo cargado (§8.4).
>
> **ENTRADA 2026-09-23 — CIERRE DE LA LANE ACL (`fb-2591` + `fb-2620`), EL ARTEFACTO
> CARGADO, LA REGLA VISIBLE EN EL PROMPT DE UN RECIÉN NACIDO, Y **UNA PREMISA HEREDADA
> RETIRADA POR MEDICIÓN** (IPD `builder-488`, lane `register-sync`, docs-only; encargo
> del HOST — el commit es del host, yo NO commiteo)** — **por qué existe esta entrada**:
> el cierre de la lane ACL es de HOY y no estaba en el registro (`grep -c`: `fb-2591`
> **0** · `fb-2620` **0** · `fb-2651` **0** · `d540e53` **0** antes de escribir esto).
> **VENTANA DE LECTURA: 13:45:09.394Z – 14:00:47.948Z**, ambas orillas medidas con
> `date +%s%3N` vía `dept_exec` — última orilla:
> `ts MEDIDO: 1790172047948 = 2026-09-23T14:00:47.948Z (source: reloj del host vía `date +%s%3N` en dept_exec)`;
> cada cifra con su fuente y su instante.
> **ÁRBOL**: `/home/esuarez/projects/deepartments`, HEAD `d540e53`
> (`git rev-parse HEAD origin/main` **idénticos** ⇒ pusheado) · stateDir `/.deepartments`.
>
> **1) CIERRE DE LA LANE ACL (`fb-2591` + `fb-2620`) — commit `d540e53`.** El fix vive
> en `packages/dshd-core/src/messages.ts`, con estos **literales**:
> `export const NON_RETRYABLE_FAILURE_GROUNDS: ReadonlySet<string> = new Set(['acl'])`
> (`messages.ts:1438`) · el predicado PURO
> `export function isNonRetryableFailureGround(reason: string | undefined): boolean {`
> cuya única línea de cuerpo es
> `return reason !== undefined && NON_RETRYABLE_FAILURE_GROUNDS.has(reason)`
> (`messages.ts:1444-1445`) · y la rama en `drivePair`
> `if (row.status === 'failed' && isNonRetryableFailureGround(row.reason)) {`
> (`messages.ts:2219`) que **precede** a la llamada de entrega
> `const status = await this.deps.deliver(record, row.recipientId, callerSessionId)`
> (`messages.ts:2408`) — **el orden está verificado por los DOS literales, no por el
> número de línea**. Esa rama asienta el par `terminal` **UNA VEZ** con un `warn` que
> declara par+status+ground ⇒ **0 intentos en vez de 12**. **Un `acl` determinista es
> TERMINAL: el par no puede entregar nunca** (la refusal se computa sobre las dos fichas
> DURABLES del catálogo — `aclDenyGround(sender, deps.busProfileFor(recipientId))`, la
> rama no-reroute de `catalogRoute`: `messages.ts:1408-1411`).
> **Test**: `test/fb2591-acl-bucle-terminalidad-c50e73ed.test.js` — **re-corrido por mí
> en esta ventana: `# pass 6` / `# fail 0`, exit 0**, con **RED-FIRST por neutralización
> de la fuente en COPIA** (el propio test sustituye el cuerpo del predicado por
> `return false` y exige que la copia queme el CAP completo; su comentario lo declara:
> «I first expected the pre-fix loop to be UNBOUNDED. It is NOT — the lane-② CAP bounds
> it at 12 attempts (24 rows for the pair)»).
> **Población medida por mí en el ledger vivo** (`/.deepartments/deliveries.jsonl`):
> **58 filas con `"reason":"acl"`, TODAS status `failed`**; **5 pares distintos**; cada
> par acumuló **12** de esas filas (`m-1818|quality-head`: **10**) **y los 5 tienen ≥1
> `terminal`**; la última fila `acl` del store es
> `ts MEDIDO: 1790166860133 = 2026-09-23T12:34:20.133Z`.
>
> **2) EL FIX ESTÁ CARGADO — y su LÍMITE, dicho con las palabras exactas.** El
> artefacto `packages/dshd-core/lib/messages.js` tiene mtime
> **2026-09-23 13:40:17.748063319 +0000** y el boot que sirve el daemon es
> `ts MEDIDO: 1790170874685 = 2026-09-23T13:41:14.685Z (source: /.deepartments/boot-crash.json, anchored to bootStartedAt + bootId 21891d64-459c-4625-a651-35deea6319c8)` — la fila
> `deploy` de `/.deepartments/restart-registry.jsonl` para ese bootId es
> `ts MEDIDO: 1790170935098 = 2026-09-23T13:42:15.098Z`, y systemd registró
> `Started dsh-deepartments-dev.service` a las **13:41:02** (journald). Sobre ese boot,
> el predicado está en el `lib` cargado (`lib/messages.js:1325`
> `export function isNonRetryableFailureGround(reason) {` y `:1787` la rama).
> **🔴 LÍMITE HONESTO — NO LO INFLES: LA RAMA NUEVA AÚN NO SE HA EJERCITADO.** El primer
> boot (código viejo) cerró **por CAP** los pares pendientes ⇒ **no queda ningún par
> `acl` sin `terminal`**: medido, **0 filas `acl` posteriores al boot** y **0
> ocurrencias** del literal del warn nuevo (`REFUSED BY ROUTE`) en journald desde el
> arranque. **⇒ La aceptación se sostiene en el ARTEFACTO CARGADO + el TEST 6/6 con su
> RED-FIRST. NO en «verificado en producción».**
>
> **3) LA REGLA ES VISIBLE EN EL PROMPT DE UN RECIÉN NACIDO: CERRADA.** El **primer
> predicado** (verificado por el host con **ancla TRIPLE**: fuente · artefacto · su
> propio pack) es: la regla de los **instantes declarados** viaja en
> `packages/dshd-core/src/wakepack.ts:403`
> (`export const HOST_WAKE_ROUTINE_TEXT =` — el literal empieza
> `'Start-of-session: your Deepartments context injection already carries identity, …`
> y contiene el bloque `DECLARED INSTANTS` con la forma
> `ts MEDIDO: <epoch ms> = <ISO> (source: <file>, anchored to <anchor>)`),
> en el artefacto de tipos `packages/dshd-core/lib/wakepack.d.ts:209`
> (`export declare const HOST_WAKE_ROUTINE_TEXT = "Start-of-session: …`), y en el
> artefacto de runtime `packages/dshd-core/lib/wakepack.js:366`.
> El **segundo predicado** — **«DECLARAR QUÉ SE EVICTA»** — lo satisfizo un **lector
> fresco del departamento de quality** (no el editor de la superficie) con un **control
> de dos columnas** contra el commit previo, que **nombró las 4 secciones evictas**:
> `Org chart` · `Pipeline` · `Worker lifecycle` · `Head lifecycle`
> (las 4 existen como encabezados en `presets/departments/quality/ARCHITECTURE.md` y
> ninguna entra en el prompt; las visibles son `Report convention` ·
> `Execution scope (dept_exec)` · `Tools` · `Report-only fix flow (D-Q5, §3.5)` ·
> `Messaging ACL (send_message)`).
> 🔴 **VOCABULARIO (cortesía del QH, aceptada): `S1`/`S2`/`S3` y «asiento» NO EXISTEN en
> este registro — son jerga de journal. Lo de arriba está nombrado POR SU PREDICADO.**
>
> **4) `fb-2651` SIGUE ENCOLADO @15:00Z — y su PREMISA DE RE-FREEZE ESTÁ RETIRADA.**
> El defecto, en pie: el marcador de truncación declara **QUE** truncó pero **no QUÉ
> quedó fuera** — `packages/dshd-orchestration/src/tools.ts:2908` devuelve
> `` `## Department architecture\n\n${rendered.slice(0, ARCHITECTURE_SECTION_MAX)}\n\n… (truncated — full text at ${archPath})` ``
> y el cap es de **CARACTERES sobre el RENDIDO**: `const ARCHITECTURE_SECTION_MAX = 3500`
> (`tools.ts:2860`) ⇒ **medir el FICHERO no lo revela**. Dueño: IPD; `next: internal-programming-head`.
> **🔴 Y AQUÍ LA RETRACTACIÓN, medida por mí (coincide con la del QH): `tools.ts` NO es
> una zona congelada EN ESTA LÍNEA y el cambio NO exige re-freeze.** La zona congelada
> es el **slice** entre dos centinelas de CONTENIDO — banner
> `  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the`
> (`tools.ts:5783`) y cierre `  }, 'deepartments: host-plane tools')` (`tools.ts:7708`)
> ⇒ el span es **[5783, 7708]**, y **`tools.ts:2908` queda FUERA**. Verificado con el
> **md5 del slice recomputado por DOS instrumentos que coincidieron** (`node -e` con el
> corte banner→close y `python3 hashlib`, ambos **`f7ed6986b8c89fa625910e3566b51fbd`**),
> valor **byte-sincronizado** con `scripts/zone-md5-manifest.json` (`cut4-tools-zone`) y
> con el literal `assert.equal(md5, 'f7ed6986b8c89fa625910e3566b51fbd', …)` de
> `test/tools-factory.test.js` ⇒ **no hay md5 que invalidar y NO hay re-freeze que
> acoplar**. **⇒ LA PREMISA HEREDADA ERA «`tools.ts` = zona congelada» (cierto del
> FICHERO) y de ella se derivó «cualquier edición exige re-freeze» (FALSO para estas
> líneas): UN ALCANCE SIN MEDIR SE HEREDA COMO HECHO.** El disparador de calendario de
> las 15:00Z lleva DOS piezas de `fb-2668` + `fb-2651` y **ya contiene la retractación**
> (medido en `/.deepartments/calendar.json`: la entrada `e6edea28-…` declara «NO EXIGE
> RE-FREEZE» y «RETIRADA LA PREMISA FALSA»). **Si las piezas van en UN solo cambio, el
> motivo es la regla de la casa «UN FICHERO, UN DUEÑO» + una sola verificación — NO el
> lock.**
>
> **5) EL CANAL DEL SISTEMA TIENE DOS CAMINOS VIVOS — HALLAZGO DEL CIERRE, no
> hipótesis.** Censo propio (solo lectura) sobre `/.deepartments/messages.jsonl`
> cruzado con `deliveries.jsonl`:
> - **`System-health ALERT` al host: 3/11 CON fila de bus · 8/11 SIN fila.** Ventana
>   medida: **13:11:36.472Z → 13:42:16.014Z**, 11 alertas dirigidas al host, **3 con fila
>   (`m-2043`/`m-2050`/`m-2060`, las tres `delivered`) y 8 sin ninguna fila**
>   (`m-2009`, `m-2011`, `m-2035`, `m-2062`, `m-2064`, `m-2068`, `m-2069`, `m-2070`).
> - **`Quality inspect`: 43/43 POR EL BUS.** La cifra se reproduce **exacta** para las
>   **43 más recientes** (`m-1533` → `m-2120`) y para la clase entera (**80/80**;
>   hoy **50/50**, todas `kind:"agent"`) ⇒ **su denominador es VENTANA-DEPENDIENTE, no
>   un tamaño de clase** — se registra con esa forma.
> **⇒ El canal tiene DOS caminos vivos: el bus y la notificación directa.**
>
> **6) DOS NORMAS DE LA JORNADA (decisión del IPH; van como DOCTRINA en §7 con su caso
> medido al lado)** — **(i) UN DISPARADOR DE CALENDARIO QUE LLEVA UNA PREMISA FALSA LA
> EJECUTA: se corrige en la ENTRADA, no en un mensaje** (la retractación tiene **radio de
> daño**: alcanza disparadores, briefs ya enviados y resúmenes; el caso de hoy es el
> disparador de @15:00Z con la premisa del re-freeze) · **(ii) AL CITAR UNA MEDICIÓN
> PROPIA SE DECLARA `medido a <ts>`, NUNCA «medido ahora»** (caso medido: una cifra que
> envejeció **72.650 s** entre la lectura y el envío del MISMO agente; y su extensión
> probada: **el `seq` de un bloque que NO se re-mide es el sello que delata la copia**
> — el mismo `seq 3748` citado en tres mensajes era la prueba de que no se había
> re-medido).
>
> **7) EL COSTE REAL DE UN DEPLOY: DOS RESTARTS, y el primero pasó canary con código
> PRE-FIX** (`fb-2673`, `estado:duplicado`, ALTO · `fb-2230`, `abierto`, ALTO — ambos
> leídos en `/.deepartments/feedback.jsonl`). Mecanismo: el bare **`pnpm build`** es
> **`tsc`** (compila SOLO `src/` raíz) ⇒ **el `lib/` del paquete queda STALE** ⇒ **cinco
> señales verdes** (`build` · `plugin add` · `dump-config` · **canary PASS** · test 6/6)
> **sobre un artefacto que el proceso NO cargaba**. El paso correcto es
> **`pnpm build:root-check`** = `node scripts/check-root-build.mjs` (regenera cada lib de
> paquete desde su src y DESPUÉS corre el tsc raíz: `scripts/check-root-build.mjs:1-34`,
> gate FB-266). **Y `lib/` está en `.gitignore:7`** ⇒ **el artefacto NO VIAJA EN EL
> COMMIT** ⇒ **el gate tiene que correr DONDE SE ARRANCA.**
> — next: host (commit de cierre) / IPD (`fb-2651` @15:00Z) — **CERRADA-la-lane-ACL**
> (register-sync 2026-09-23, builder-488).
>
> **ENTRADA 2026-09-23 — CIERRE DEL BLOQUE D270 + GATE DE `lib` STALE: `30→25` NO ES
> ATRIBUIBLE POR CONTEO, LA EXENCIÓN ES DE **5 CONDICIONES Y NO 3**, Y LA CLASE `fb-2673`
> LA REPRODUJO UNA LANE Y LA CAZÓ EL INSTRUMENTO DE LA OTRA LA MISMA JORNADA** (IPD
> `builder-491`, lane `register-sync`, docs-only; encargo del IPH — **el commit es del host,
> yo NO commiteo**).
> **ÁRBOL**: `/home/esuarez/projects/deepartments`, HEAD `1d2ba7f` = `origin/main`
> (`git rev-parse HEAD origin/main` **idénticos** ⇒ pusheado) · stateDir `/.deepartments`.
> **ORILLA DE ESCRITURA**:
> `ts MEDIDO: 1790175268388 = 2026-09-23T14:54:28.388Z (source: `date +%s%3N` vía `dept_exec`, anclado a su propio par epoch/ISO)`.
> **Instante de cierre del trabajo (segunda orilla, medida DESPUÉS de escribir la entrada)**:
> `ts MEDIDO: 1790175476243 = 2026-09-23T14:57:56.245Z (source: `date +%s%3N` y `date -u` vía `dept_exec`, anclados a su propio par epoch/ISO)`.
> **1) LOS COMMITS DEL BLOQUE — cuatro, cada uno con su tamaño real.** **`1d2ba7f`** **lane A
> / D270** (la exención de aviso de salud sobre el PROPIO post del destinatario):
> `packages/dshd-core/src/delivery.ts` **+112/−7**, md5 del fichero commiteado
> **`48637b6e375f7093c032754b2349477d`** — **re-verificado por mí en las DOS orillas**
> (`git show 1d2ba7f:packages/dshd-core/src/delivery.ts` y el working tree: **idénticos**) —
> más `test/d270-health-notice-exemption-ca72b481.test.js` **+263** (PASS de `reviewer-166`) ·
> **`264b48a`** `README.md:63` + `README.zh.md:42` **al gate REAL** (+4/−2) · **`fe504c2`**
> la decisión de la curación R23/R24 entra al RD (`docs/departments/research/SOURCES.md`
> **+16/−0**) · y **`24a3a81`** **el gate de `lib` stale, como PIEZA PREVIA** (5 ficheros,
> **+730/−75**: `scripts/check-root-build.mjs` +416 · `test/stale-lib-gate.test.js` +316 ·
> `docs/VERIFICATION-LADDER.md` +67 · `AGENTS.md` +1/−1 · `package.json` +3/−1).
>
> **2) 🔴 EL DELTA DE ROJOS: POR SET-DIFF POR NOMBRE, NUNCA POR CONTEO.**
> **«30→25 NO es atribuible por conteo (baja 5 y sólo 2 son de la excepción)»** — el total
> baja 5, pero **sólo 2 entradas** son de la excepción: las otras 3 se van y 1 llega por
> ruido de entorno. El par comparable es **BASE(14:08) → AFTER2(14:15)**:
> **desaparecen 6** — 2 **de la excepción** (`D270 CASE 1` + `D270 CASE 3`) y **4 flakes**
> `ENOTEMPTY`/daemon (`deps-holder-baseline` · `M2 (B1 discriminator)` ·
> `M4 system-idle SMOKE` · `O1-EXT P2`) · **aparece 1** (`boot-factory`) · **26 permanecen
> idénticos** en las tres corridas. Medido por mí con `comm -23/-13/-12` sobre los `.txt`
> de rojos: **32 → 27 líneas, 6 fuera, 1 dentro, 26 comunes** — **coincide exacto** con el
> set-diff del review (§9). **Y el log llamado «AFTER» NO era comparable: era MÁS VIEJO que
> el BASE** (`d270-full-ca72b481.log`, `14:04:42`, **1518** tests y **0** ocurrencias de
> `fb-2673` frente a las **22** del BASE) ⇒ **el par bueno es BASE→AFTER2**, no BASE→AFTER.
> Instantes de los TRES artefactos, medidos por mí sobre el fichero y anclados a su propio
> par epoch/ISO:
> `1790172282 = 2026-09-23T14:04:42.169688+00:00` (source: mtime de `…/d270-full-ca72b481.log`) ·
> `1790172484 = 2026-09-23T14:08:04.571254+00:00` (source: mtime de `…/d270-BASE-ca72b481.log`) ·
> `1790172938 = 2026-09-23T14:15:38.074225+00:00` (source: mtime de `…/d270-AFTER2-ca72b481.log`).
> ⚠️ **Los tres artefactos viven en el WORKSPACE DEL DEPARTAMENTO**
> (`/root/.deepartments/departments/internal-programming/`), **no en la raíz del repo**:
> quien los busque en `/home/esuarez/projects/deepartments` encontrará **sólo el test**.
>
> **3) `boot-factory` NO ES REGRESIÓN — y tampoco es «un flake» dicho sin mecanismo: ES UNA
> CARRERA DE TEARDOWN.** **Primero la CLASE del error, después el nombre del test.** El error
> literal es `ENOTEMPTY: directory not empty, rmdir '/tmp/deepartments-boot-factory-EKIxDj'`,
> con `failureType: 'testCodeFailure'` y `location: test/boot-factory.test.js:261:1` ⇒ **el
> que falla es el `rmdir` del tmpdir, NO una aserción del test** (nada del contrato del
> composed boot se puso en duda). **CONTROL POSITIVO — la misma clase YA estaba en BASE
> mordiendo a OTRO test**: `deps-holder-baseline`, `ENOTEMPTY: directory not empty, rmdir
> '/tmp/deepartments-holder-baseline-9n5orX'` (`d270-BASE:842-849`, `location:
> test/deps-holder-baseline.test.js:152:1`) ⇒ **la carrera es PRE-EXISTENTE y lo único que
> cambió fue A QUÉ TEST le tocó.** Por eso el rojo «nuevo» no es del fix: es el mismo dado
> cayendo en otra casilla.
>
> **4) LA EXENCIÓN ES MÁS ESTRECHA DE LO DECLARADO: 5 CONDICIONES, NO 3 — y nunca levanta
> un ground real de scoping.** Las tres conocidas (`from === 'deepartments'` · forma de aviso
> reconocida · `notice.postId === recipientId`) **más** `ground !== 'unclassified-sender'`
> (`delivery.ts:1432`) y `route.kind !== 'post'` (`:1433`, verificado en fuente por mí).
> Símbolo: **`exemptOwnPostHealthNotice()` (`packages/dshd-core/src/delivery.ts:1426`)**;
> el predicado PURO sigue en `aclDenyGround` (`packages/dshd-core/src/acl.ts:102`) con
> **arity 2 asertada por el test** (`assert.equal(aclDenyGround.length, 2, …)`): **un futuro
> «arreglo» que mueva la exención al predicado puro FALLA ahí** — la firma no tiene mensaje,
> luego no puede tener regla condicionada por contenido. **Y el hallazgo de producción que
> justifica la lane**: el aviso self-directed de `fb-759`
> (`packages/dshd-orchestration/src/tools.ts:7861`, `const selfDirected = headId === postId`)
> **YA declaraba `noWake` pero se liquidaba `failed/acl`** ⇒ **la cabeza NUNCA se enteraba de
> su propio error**. D270 **repara un canal que ya existía y moría en el ACL**; no inventa
> uno.
>
> **5) 🔴 R-2 DECLARADO — CIFRA SIN ARTEFACTO.** La cifra **«1529/1478/27»** del informe de
> `487` **NO TIENE ARTEFACTO EN DISCO** (su `.log` se borró: `find … -name "*b487*"` ⇒ **0**
> ficheros, y `# pass 1478` **no aparece en ningún `.log`** del workspace — verificado por mí).
> Lo que SÍ está en disco, y **estas son las medidas que VAN AL REGISTRO**, verificadas por
> mí línea a línea en los tres artefactos:
> ```
> d270-BASE-ca72b481.log    → # tests 1529  # pass 1475  # fail 30
> d270-full-ca72b481.log    → # tests 1518  # pass 1464  # fail 30
> d270-AFTER2-ca72b481.log  → # tests 1531  # pass 1482  # fail 25
> ```
> ⇒ **la cifra «1529/1478/27» es una cifra SIN ARTEFACTO y se cita como tal**; la atribución
> «0 fails nuevos» que se apoyaba en ella **no es verificable desde disco** (lo verificable
> es el set-diff del punto 2, que sí lo es).
>
> **6) R-3 DECLARADO.** La forma `post-error` (`delivery.ts:1405`) matchea el **PRIMER** bullet
> de un frame multi-bullet — y **hoy NO es alcanzable**: el único emisor multi-finding es el
> ALERT al host y esa ruta queda **excluida** por `route.kind !== 'post'` (`:1433`). Queda
> declarado como residual de diseño, no como agujero vivo: **si alguien añadiera un
> `notifyPost` multi-bullet, esa forma no lo estrecharía.**
>
> **7) ⭐ EL HALLAZGO CRUZADO — vale más que el gate.** El `lib` que el **runtime resuelve**
> iba **13 s por detrás** del `src` de la lane A **y lo cazó `pnpm build:check`, el
> instrumento de la lane B** ⇒ **la clase `fb-2673` (el artefacto stale que el proceso sí
> carga, mientras el `src` ya está arreglado) fue REPRODUCIDA por una lane y CAZADA por el
> instrumento de la OTRA, la misma jornada.** Es la mejor evidencia de que el gate de
> `24a3a81` vale lo que dice: no lo demostró un test sintético, lo demostró un artefacto
> real desincronizado por trabajo en vuelo.
> ⚠️ **LÍMITE DECLARADO (no lo pude re-medir)**: los **13 s** son **declarados por
> `reviewer-166`** (su medición a las 14:27, con `src/delivery.ts` editado a las 14:23:51);
> **yo NO pude reproducirlos** porque para cuando medí el árbol la reconciliación del host ya
> había corrido: `packages/dshd-core/lib/delivery.js` tiene mtime **2026-09-23 14:45:57** y
> el `src` **14:23:51** ⇒ hoy el `lib` es **más NUEVO** que el `src`, no 13 s más viejo. Se
> registra la cifra **como declarada, con su autor y su instante**, no como medición mía.
>
> **8) CONTROL «¿qué se rompe si lo hago?» — declarado aunque sea CERO.** (i) El comando
> pedido (`grep -rn "1529\|1478\|1475\|1482" test/ scripts/`) da **6 líneas**, y **ninguna
> asevera el contenido del registro ni esas cifras**: 4 son el **`fb-1478`** (un id de
> feedback, no el `1478` de `# pass`), 1 es el **`m-14826`** (un mensaje), 1 es un
> **`ts":1788321475650`** dentro de un fixture JSON ⇒ **0 aserciones reales = CERO**. (ii)
> **La trampa del instrumento, comprobada en carne propia**: el mismo grep **nombrando
> `.dsh/` directamente da 272 coincidencias** que el grep con ignore-rules **no ve**
> (`.dsh/` es dotdir y está en `.gitignore`) ⇒ **un CERO de un grep con ignore-rules NO es
> prueba de ausencia**. Aquí las 272 son **reportes históricos ajenos** que citan `:1478` o
> `m-14826`, **no** el `# pass 1478`, y **no aseveran este registro**. (iii) **Impacto REAL
> medido: CERO, y por construcción.** El `docs/WORK-REGISTER.md` **sí se lee en vivo** — dos
> consumidores: `countPendingWorkRegister` (`packages/dshd-core/src/pacing.ts:250`, el «N» del
> aviso de VALLE) y `parseWorkRegisterItems` (`packages/dshd-health/src/index.ts:8260`, el
> watchdog `work-register-idle`). **Los dos parten el texto por `^##\s+` y ARRANCAN EN `i=1`**
> ⇒ **todo lo que vive ANTES del primer `## ` (la cabecera y TODAS las `ENTRADA …`) queda
> FUERA del censo**. Medido por mí con el algoritmo exacto de `pacing.ts` sobre el fichero
> real: **482 items contados**, y **esta entrada se inserta en el preámbulo** (antes del
> primer `## `, que estaba en `:809` **antes** de escribirla y en `:939` **después** — la
> propia entrada movió el fichero +130 líneas; el conteo del parser **NO se movió: 482 antes
> y 482 después**, medido con el algoritmo exacto en las DOS orillas) ⇒ **aporta 0 al
> conteo**. Eso explica —y fija— el formato de
> las entradas: son prosa narrada fuera del censo, **no** items de cola. (iv) `docs/ROADMAP.md`
> **no se asevera por contenido**: su único lector es el tail del wake pack
> (`readWakeRoadmapTail`, `packages/dshd-core/src/wakepack.ts:863`), que toma los **3 últimos
> bullets** de `## Current status` y los condensa ⇒ **añadir un bullet al final es la
> operación prevista**, y ningún test compara ese texto (los matches de `ROADMAP` en `test/`
> son del *string* `## ROADMAP current status (tail)` construido en memoria, no del fichero).
> — next: host (commit de cierre) — **CERRADO-el-bloque-D270 + gate de `lib` stale**
> (register-sync 2026-09-23, builder-491, run token `bdb1b8b6`).

## 1. IPD — cola activa (DAG seriado, lección fb-20: UN lane a la vez)
<!-- ⚠️ Vigencia: los ítems de esta sección son HISTÓRICOS (09-06→09-10) salvo el
     bloque «⏱️ COLA VIVA DEL IPD al 2026-09-22T20:23Z», que es la cola de HOY. -->

> **FORMATO `next:` (convención docs — diseño fb-184 ITEM 4,
> reports/explore-deep/2026-09-06-fb184-watchdog-idle-v2-design-586effda.md
> §ITEM 4; el PARSE es lane separada fb-184, aquí SOLO la convención del
> registro)**: cada item del DAG IPD lleva `— next: <actor>` nombrando al
> PRÓXIMO actor que lo toma. Patrón: `**<label>** … — next:
> internal-programming-head` (items de implementación/IPD) · `next: host`
> (settlements / push+verify del host — clase settlement-wait fb-167, convención
> ya adoptada en el registro). El watchdog work-register-idle v2 (fb-184) lee
> este campo para notificar «next-actor-idle» al actor nombrado.

### ⏱️ COLA VIVA DEL IPD al 2026-09-22T20:23Z — esto es lo que un relevo necesita leer
PRIMERO (lo de arriba en §1 es histórico del 09-06→09-10 y NO es la cola de hoy)

- **EN VUELO — las 5 del encargo del host + las nacidas después** (estado de `dept_who`
  leído **20:23Z**, y `ts` del envío en `/.deepartments/messages.jsonl`; la misión en
  UNA línea, con el id del worker):
  - `builder-465` (enviado 19:19:15.487Z) — **D40**: el docstring de `accountedWaitMs`
  -  la cifra BRUTA del presupuesto de espera + el aserto con TOLERANCIA, y la etiqueta
    de **«downtime» que publica un uptime** (`dsh-smart-restart/src/boot.ts:41-43`:
    `downtimeMs = nowMs − prevBoot` = el UPTIME del ciclo anterior).
  - `builder-466` (19:24:49.673Z) — **Lane A**: por qué NO corre la rotación del host +
    el `ctx.logger` del bundle, que es **MUDO** (medido: **20 líneas `[deepartments]`
    en 24 h**, TODAS de arranque — 17 `online` + 3 `channel mounted`, p. ej. **2** en
    las 1 h 18 min del pid 1858100 — contra **9.654** del pooler en el mismo periodo).
  - `explore-deep-142` (19:28:10.742Z) — el **lock de `atomic-write`/credentials**:
    MEDICIÓN, no arreglo.
  - `builder-467` (19:31:43.024Z) — **`heap-band-truth`** (hoy `idle` en `dept_who`; es
    la única cuya ausencia no deja arreglo a medias y el host la re-despacha al otro
    lado del relevo).
  - `explore-deep-143` (19:38:10.365Z) — consumidores de `next-turn`.
  - **`builder-470`** (19:54:45.096Z) — **LA LANE DEL DRENADO** (`drain-at-step-end` +
    `drainedAt`) **con la VÍA (A) DENTRO**: enrutar, `claim` intacto.
  - **`builder-472`** (20:03:51.687Z) — el lock huérfano del canary, 2 defectos en
    `dsh-smart-restart`.
  - **`builder-474`** (20:10:54.723Z) — `rotation-seam-migration`, la CURA del seam de
    rotación (código NUESTRO, no parche de harness).
  - **`explore-deep-146`** (20:13:11.688Z) — `token-usage-truth` (medición).
  - **`explore-deep-147`** (20:14:41.741Z) — `report-read-receipt` (medición).
  - **Y `builder-469`** (19:49:10.325Z) — `fb-1981`, las dos ediciones de TEXTO; **ya
    commiteado** como `dccbb1e` 20:05:34Z.
  - ⚠️ **DECLARADO**: los 5 del encargo del host están vivos **en el instante 20:23Z**;
    `builder-466`, `explore-deep-142`, `explore-deep-143` y `builder-469` tienen fila en
    `/.deepartments/posts-retired-archive.jsonl` (19:53:45.361Z, 19:53:47.111Z,
    19:57:38.647Z, 20:03:48.331Z). **Esas cuatro filas de retirada NO las resuelvo por
    mi cuenta**: un post retirado con handle vivo es la clase `fb-115`/`fb-301` ya
    conocida ⇒ **lo señalo en vez de adjudicarlo** (el head lo verifica en la línea).
- **COLA APROBADA, EN ORDEN** (host `m-1270` 19:46:35.107Z + reordenación `m-1237`
  19:34:04.760Z + corrección `m-1276` 19:48:13.235Z): **`drain-at-step-end` +
  `drainedAt` [YA DESPACHADA, `builder-470`, con (A) dentro] → Lane B** (diferir el
  `append` del journal al `agent/pre-step` del wake — **va DESPUÉS de Lane A porque es
  el MISMO fichero**; el `append` de hoy es `dshd-core/src/lifecycle.ts:750` en la
  numeración PRE-`b4d3701`, verificado con `git show b4d3701~1:…`) → **W5** → **TRES
  PUERTAS** → **las cinco clases** → **`heap-band-truth`** → **la política del tick** →
  **W13/W14** → **nudge + CLI**.
- **LOS TRES ENCARGOS DEL QD SIN DESPACHAR** (host `m-1270` §2e): **`fb-2427`** (3
  piezas: RUTA + **ADAPTADOR DE FORMA v7→v3** + CIFRA — **NO es one-liner**; ⚠️ lo he
  medido: el monolito `session_projcache.json` es **`version 3`** con `tables.sessions[sid].rows`
  y la vía viva es **por registro, `version 7`, con `record.rows` y SIN `tables`** —
  `/opt/dsh/.dsh-dev/storages/session_projcache/sessions/<sid>.json`, 712 ficheros, con
  las DOS sesiones del head vivo presentes; el fallo de RUTA solo sigue devolviendo
  `undefined` ⇒ el adaptador es necesario, confirmado en la línea) · **la laguna del
  ledger de sellos** — **medición propia, 2026-09-22T20:13:29Z**:
  `/opt/dsh/.dsh-dev/storages/session_projcache.json.seals.jsonl` tiene **125 filas**,
  **0 con `datumTsIso` del 09-22**, **mtime 2026-09-21 15:26:53.505039243Z** y su
  ÚLTIMA fila es **2026-09-21T15:26:53.433Z** ⇒ **28,78 h mudo** en el instante de
  leer, con rotaciones del QH/IPH/RD ocurridas dentro de la ventana ⇒ es un hecho
  medido, **NO adjudicado como «el mismo espejo congelado»** (por eso es medición
  separada y no se pliega) · **`fb-2439`** (poblar el `ts` de `reasonProvenance`):
  **medido por mí en `/.deepartments/tool-intents.jsonl`** — de **4** intents de
  `dept_head_rotate` en el store, **3 llevan `reasonProvenance` y los 3 llevan SOLO
  `sessionId`**; **0 llevan `ts`**; el esquema SÍ declara `ts`
  (`dshd-orchestration/src/tools.ts:7449`, opcional). ⚠️ **CIFRA DECLARADA CON SU
  LÍMITE**: `tool-intents.jsonl` es APPEND-ONLY y el daemon PURGA, así que el fichero
  VIVO ya no es la población del día — el `4/3/0` es lo que hay HOY en el store vivo,
  leído en la ventana de esta entrada (la cifra del host —«2 de 3 rotaciones»— la dejó
  él y no la contradigo: la mía cubre otra población). **Y el campo es un emisor
  PARCIAL: a veces viaja el sujeto y NUNCA el instante.**

- **fb-2523 · MISIÓN ENCOLADA, CON TRIGGER — la regla al final de un ARCHITECTURE.md
  nace muerta** (sin fecha — con trigger):
  Superficies: `presets/departments/quality/ARCHITECTURE.md` · `packages/dshd-core/src/wakepack.ts`
               · `.dsh/skills/deepartments-workflow/SKILL.md`   (SOLO esas tres)
  Trigger: (a) cuando el IPD rote o recupere margen · (b) valle abierto a las 05:30Z con ventana
           · (c) cuando el QH cierre su lote
  Accept: (1) LA REGLA ES VISIBLE EN EL PROMPT DE UN RECIÉN NACIDO (NO «antes de un corte
              medido en el fichero»: el cap se aplica al RENDIDO — FILE 9.641 vs RENDERED 9.780 —
              y medir el fichero puede hacer creer que un bloque entra cuando ya está fuera);
          (2) DECLARAR QUÉ SE EVICTA (la ventana es de SUMA CERO; medido: `builder-480` puso la
              regla en la línea 11 y `Execution scope (dept_exec)` pasó de VISIBLE a INVISIBLE)
  Medidas ya hechas: 45 % el QH · 59 % el IPD · 35 % el RD · `Report convention` fuera en 2 de 3
                     · el cap es de CARACTERES (`packages/dshd-orchestration/src/tools.ts:2860`)
  Dueño: IPD. Especifica/verifica: QH (reporta, no escribe). Commitea: host.
  NO RE-DERIVAR las medidas: están en `fb-2523` / `fb-2527`.

- **PARA EL REGISTRO, un hecho que cambia la lectura de «terminal»** (host `m-1101`,
  17:00Z, y QD `m-1179`): `delivered` se escribe o NO **según el estado del destinatario
  en el instante** (`dshd-orchestration/src/delivery.ts:1974` → `return 'prepared'` si
  estaba `running` + batch-eligible; `:2025` `delivered`; `:3030` `batchEligible:false`
  en la costura de recuperación) ⇒ **la fila de entrega NO es determinista** y esa es la
  materia de W5, con dos instancias duras (`m-892`/`m-980` `terminal` SIN `delivered`
  para un par que en `m-799` SÍ entregó).

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
    CERRADO 09-09 por decisión host (fix público Discussion #5826; issue #NN
    opcional; merge upstream no perseguido) — ver ENTRADA CIERRE DE JORNADA
    (decisión host m-4149); RESTO fb-51 owner-grade opcional → §3
    PENDIENTE-OWNER (sin inventar #NN)
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
    operando) — next: host (commit repo dsh-key-pooler, add explícito del
    host) — CERRADO-en-entrega (CIERRE BLOQUE 1 09-09 — implementación
    LISTO-PARA-COMMIT, builder-228 09ebe790 + reviewer-118 PASS 2f59ba26; el
    gate consumidor deepartments queda DIFERIDO a junción host-move rc.2 —
    cierre formal fb-75; ver ENTRADA CIERRE BLOQUE 1).
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
- **fb-548 (CANÓNICO; `fb-545` = el original ARCHIVADO como duplicado suyo:
  `duplicate_of: fb-548`, `cerrado_por: quality-head` — medido por el host en el
  ledger y corroborado por el dedupe del backlog: LIVE, `abierto`,
  `triage_owner: internal-programming-head`) — 13 rojos pre-existentes de
  `test/invoke.test.js` en HEAD `39ba33b` — LANE DE CLASIFICACIÓN,
  **CERRADA-en-clasificación**; docs-only, 0 commits, 0 ediciones; reporte +
  DOBLE gate de reviewer, ronda 1 y ronda 2 — resultado **12 OBSOLETO**
  (por DISEÑO 10: #16, #78, #113, #149, #157, #185, #301, #459, #503, #517 · por
  FIXTURE 2: #116, #118) · **1 REAL (#151)** · **0 FALSO-RACE**.**
  Los **13 presentes SIEMPRE** (14/14 presencias en ronda 1 y ronda 2 —
  2 suites + 2 aisladas + las 3 limpias del reviewer ronda 2): el reviewer de
  ronda 2 corrió la suite completa **3 veces, secuencial y sola**
  (23:19:16 / 23:20:29 / 23:25:25 UTC, **568/533/13/22 EXIT=1 las TRES**, los
  mismos 13 rojos y un solo bloque TAP) ⇒ **la baseline 13 SÍ se reproduce** y es
  la **declarable**: **13 rojos CON NOMBRE** (los mismos en 3/3), **NUNCA una
  cifra suelta**; lo que existe es un **flake INTERMITENTE FUERA de los 13**
  (clase con dueño, ver (4)), NO una baseline 14.
  Claves medidas: **#116/#118 = OBSOLETO-por-fixture** (el reviewer lo reprodujo
  con instrumento PROPIO: `[R2-MOUNT]`=0, `[R2-APPLY]`=0, `[R2-AUDITDIR]`=0,
  `[R2-REJECT]`=7 y literal del `catch` **byte-equivalente**) · **10/10** presets
  que NUNCA montan en la suite hermética (pre-flight de resolubilidad) ·
  `run3.log` = **2/2** limpias · **#149** en `test:7791` (`:7798` no corrió) ·
  **0 ediciones** (md5 == blob de HEAD, HEAD inmóvil).
  **Rutas ABSOLUTAS**: informe (con §0.5 = las 3 correcciones aplicadas del gate
  de ronda 2) `/root/.deepartments/departments/internal-programming/reports/explore-deep/2026-09-10-fb545-13-reds-classification.md`
  · review ronda 1 (FAIL 3a) `/root/.deepartments/departments/internal-programming/reports/reviewer/2026-09-10-fb545-13-reds-classification-review.md`
  (run token `ebcbfa3c`) · review ronda 2 (PASS 5/6; FAIL sólo el punto 4 =
  baseline, ya corregido) `/root/.deepartments/departments/internal-programming/reports/reviewer/2026-09-10-fb545-ronda2-review.md`
  (run token `d3d3cd00`).
  **FOLLOW-UPS ABIERTOS (sin lane asignada; los abre esta línea)**:
  (1) **fixture de #116/#118/#113 — DECISIÓN (ii) del host**: los tests deben
  **asertar el estado real** (`preset.broken`;
  `node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js:406`/`:413`/`:1406-1409`;
  **`unmountableReason` NO existe**) y **dejar de afirmar un montaje que la suite
  hermética no puede producir**; **NO** hacer montables las filas (hoy el fallo de
  montaje es invisible y el fixture se cree «montado»);
  (2) **`#151` y `#82` — `fb-580` (canónico)**: una ficha, dos manifestaciones,
  raíz común `packages/dshd-orchestration/src/tools.ts:5421-5422`
  (`ensureAllHeads` fire-and-forget, sin await ni catch; terminales distintos:
  `createScope`/`INACTIVE_EFFECT` vs `Object.setup`/`without inject`) ⇒ el **fix va
  DESPUÉS de la misión C**, con test que reproduzca el `unhandledRejection`;
  (3) **`#517` — PRECONDICIÓN DECLARADA (decisión del host)**: permanece
  **OBSOLETO-por-diseño**; **si una lane futura reintroduce semántica F8/sueño de
  head**, entonces **`#517` pasa a REAL y la guarda B3 pasa a ser el bug** (el sleep
  de heads está **RETIRADO desde el LOTE A**; sólo el host rota);
  (4) **CLASE FLAKE fuera de los 13 — `fb-581` (canónico; dueño QD)**: baseline
  declarable = **13 rojos CON NOMBRE** (los mismos en 3/3: 568 tests/533 pass/13
  fail/22 skipped, EXIT=1), **NUNCA una cifra suelta**; extras **intermitentes y
  variables** (0, 0, +2 ⇒ `#82`/`#100`; en concurrencia 15/16/16 con
  `#340`/`#168`/`#173`/`#174`/`#175`/`#547`); **constraint del host: la suite SIEMPRE
  secuencial y en solitario**; **criterio QD**: antes de clasificar **REAL** cualquier
  rojo futuro ⇒ **N≥3 corridas secuenciales y en solitario + dos columnas**; límite
  declarado: N=3 **no** permite estimar tasa;
  (5) **A2c** — título del bloque HERMANO
  `test/invoke.test.js:8355` (`fb-33` crash-safety) factualmente falso y
  autocontradictorio con su propio cuerpo; (6) **docstring stale**
  `test/invoke.test.js:10827-10828` (`snapshotRoleTemplate`, ejemplo de
  `execbuilder.md` «restores to ABSENCE»);
  (7) **HUECO ESTRUCTURAL con dueño (QD) — canónico `fb-582`** (`fb-579` = el
  original del IPD, ARCHIVADO como duplicado suyo: `duplicate_of: fb-582`,
  `cerrado_por: quality-head`): en la suite hermética **NINGÚN preset se monta
  (10/10 rechazos)** ⇒ hoy ningún test puede probar que una fila de preset **se
  APLICA** ⇒ un preset roto y uno correcto producen **el mismo verde**; y `fb-435`
  añade interferencia (la suite además **REVIERTE** ediciones no commiteadas de
  `presets/**`) — pista de cierre: el rechazo viene del **walk en disco del
  pre-flight** (4 filas MISSING reales vs `dsh-deepartments/subagent` importable por
  Node). **NOTA `fb-548` (RESUELTA — medida en el ledger)**: el **canónico** es
  `fb-548` (LIVE, `abierto`, `triage_owner: internal-programming-head`) y `fb-545`
  queda **ARCHIVADO como duplicado suyo**; ya NO hay «pliegue pendiente de
  confirmación del host».
  — next: internal-programming-head
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

## 3. PENDIENTE-OWNER (decisiones — ⚠️ ESTADO HISTÓRICO: **los ítems de abajo son el
estado al 09-09**; NO es la vigencia de hoy — la vigencia VIVA de las decisiones del
owner al **2026-09-22T20:23Z** está al final de esta sección, sub-bloque «ESTADO VIVO
2026-09-22», y §4 lleva su propio encabezado con la misma marca)

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
  para REVISIÓN del host antes de publicar; **RECONCILIACIÓN FINAL 09-09 (decisión
  host m-4149 — CIERRE DEFINITIVO)**: D1 PUBLICADO 09-06 (owner presente) + revisión
  host PASS (Discussion #5826 verificada live) → **fb-51 CERRADO 09-09 por decisión
  host (fix público Discussion #5826; issue #NN opcional; merge upstream no
  perseguido)** — la parte «publicar» quedó CERRADA (§1 OLA POST-PREP, actualizado
  a CERRADO); **RESTO fb-51 = owner-grade OPCIONAL** (fork re-push/push-day ·
  merge upstream vía instancia interna DeepSeek · issue interno #NN sin inventar)
  — PENDIENTE-OWNER; acción del HOST (clone/PR/
  rebuild del monorepo — no construible desde los roots del lane).
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
  OPCIONAL → decisión OWNER; w-3/af4757c + STORES-MAP.md §1) — ABSORBIDO por la
  decisión fb-285 (CERRADO-anotado 09-09)**: el footprint stale
  (`health-heartbeat.json`/`posts.json`/`config-presets` 09-03, clase fb-134
  CERRADO) = el MISMO footprint resuelto por fb-285 (ANOTAR-no-purgar; esos
  archivos entraron en los 19 mv `.stale-2026-09-09-fb285-*` host-plane) → sin
  archivo/acción propia; sigue vigente NO unificar el `.dsh/reports` legacy sin
  decisión (D-6 «no-tocar»).
- **fb-285 (QD, 09-09 — limpieza GLOBAL del ghost-store /root/.deepartments) —
  CERRADO-anotado 09-09** (hermana global de fb-136/fb-284; record QD): debris
  huérfano de una instalación previa en la raíz del workspace
  (hosts/messages/posts/restart-registry/health-alerts*/secrets//departments —
  mtimes 08-23→09-06; el store vivo es /.deepartments; familia fb-134) —
  **decisión HOST (DELEGACIÓN TOTAL owner 09-09) = ANOTAR-no-purgar**, ejecutada
  en ZONA HOST-PLANE: **19 mv reversibles `.stale-2026-09-09-fb285-<basename>`
  aplicados por el HOST (~15:3xZ 09-09)** — 18 archivos ghost + el dir
  `secrets/` ENTERO renombrado SIN listar (fb-16, modo 700 preservado
  `drwx------`) · por qué host: dept_exec de los workers DENIEGA el top-level de
  /root/.deepartments (guard OUT_OF_SCOPE; precedente fb-284) · pre-check 0
  escritores activos (mtimes 08-23→09-06) · `departments/` EXCLUIDO (VIVO —
  reports 09-09; fb-285 lo lumped por error) · marker fb-284 NO tocado ·
  `/.deepartments` (stateDir live) INTACTO. **LECCIÓN DE SCOPE (futuras lanes de
  higiene del ghost-store)**: el top-level de /root/.deepartments es ZONA
  HOST-PLANE para renames — los workers no la alcanzan por dept_exec
  (OUT_OF_SCOPE): ejecución por el HOST, anotación docs por IPD.
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

### ⚠️ ESTADO VIVO 2026-09-22 (lectura **2026-09-22T20:23Z**) — esta sub-sección SÍ es
vigencia; todo lo de arriba en §3 es histórico al 09-09

- **RECIÉN CERRADAS POR EL OWNER (hoy, 09-22)** — NO son pendientes: **JEV** ⇒ **NO se
  adopta** (veredicto del host `m-869` 16:21:13.914Z, tras la evaluación del RD de
  `m-796`; 3 de 4 usos inviables por límite físico del modelo o duplicación; lo ÚNICO
  abierto = el uso 2 «valoración de logs» como preFiltro, **aparcado a la palabra del
  owner** y con decisión de datos del host: **jamás con logs reales**, corpus
  redactado/sintético y coste $0; handoff al head nuevo del RD en `m-1087`
  18:02:18.018Z) · **la decisión A/B del drenado** ⇒ **VÍA (A): ENRUTAR** (host
  `m-1276` **19:48:13.235Z**, que CORRIGE su propio `m-1270` de 19:46:35.107Z:
  «la decisión A/B YA ESTÁ TOMADA, no preguntes por ella»; el owner la había dicho
  textual —«nos drena todo el buzón después de cada step»— y el QH confirmó que el
  `1` del `claim` es **CONTRATO DOCUMENTADO** del README del driver ⇒ `claim` NO se
  toca; la vía es enrutar; el owner CONSERVA el veto y el host lo comunicaría en el
  mismo turno). **Medición mía de la entrega de esa corrección** (porque hoy se
  falsificó una entrega): `deliveries.jsonl` tiene para `m-1276` `terminal`
  **19:48:14.270Z** y `delivered` **19:48:42.716Z** ⇒ llegó, y arrancó `builder-468`
  el mismo segundo (19:48:12.955Z de envío del brief). **Y el veto NO llegó** desde
  entonces hasta las 20:23Z (0 mensajes del host en ese hueco con la palabra veto).
- **SIGUEN PENDIENTES DEL OWNER (3, y son suyas, no de la cola técnica)**: **volumen
  de despacho masivo** (`m-1225`, 19:31:01.735Z) · **idioma del registro**
  `/root/DECISIONES-HOST.md` (ídem; ⚠️ `dept_exec` me lo deniega como ruta — está
  FUERA de los roots de la lane, así que su contenido NO lo verifiqué) · **y el piloto
  de JEV uso 2** si algún día lo quiere, dentro de lo ya decidido. **El host declaró
  explícitamente que no había despachado nada de eso sin su palabra** (`m-1225` §4).
- **UN ENCARGO DEL OWNER EN VUELO, nacido hoy de su mano** (`m-1322`/`m-1345`/`m-1355`/
  `m-1359`, entre 20:03 y 20:14Z): eficiencia de sesiones por tokens, **asegurar la
  lectura de informes** («hay que asegurar que los informes se leen»), y el barrido
  del servidor. **No lo inventes de memoria: está en las lanes vivas de §1.**
- **CONTEXTO DE ESTA SUB-SECCIÓN**: la escribo con los mensajes del host leídos EN EL
  LEDGER (`/.deepartments/messages.jsonl`) con su `ts`, no de resumen. Si algo caduca,
  se MARCA con su fecha (política de cita del RD, `m-1087` §3) — no se borra.

## 4. CAPACIDAD (⚠️ encabezado HISTÓRICO: el cuerpo de abajo es **al 09-08**; la
vigencia viva al 2026-09-22T20:13:29.524Z va en el sub-bloque «CAPACIDAD VIVA» al
final de esta sección)

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

### 🔴 CAPACIDAD VIVA (lectura **2026-09-22T20:13:29.524Z**, fuente
`GET http://127.0.0.1:4097/__keypool/status`, HTTP 200) — **el cuerpo de arriba NO
describe esto: describe el 09-08**

- **`eligibleKeys 0` · `totalKeys 0` · `halted:false`** y **`keys:[]`** en la
  proyección de uso (`maxWeeklyPct:null`). ⇒ **hoy NO hay NI UNA key Go usable**: todas
  las conocidas están tombstoned por `monthly-100` (`lastRotation`: `oc-15` →
  **ninguna**, 2026-09-17T22:00:53.290Z, reset **2026-10-03T12:20:28.154Z**).
  **El tráfico lo sirve la PATA PEER**: canal `commandcode` `enabled:true` ·
  `peer:true` · `ready:true` · `keys:2` (`cc-2`, `cc-4`) · `usageSource:"none"` ·
  contador de la pata **`{requests:1689, slots:1689, answered:1683}`** (ese contador
  SÍ es medición del instante). **`officialBlocked:false`** en el canal (los 0
  rechazados = caso sano).
- **Y el veredicto de agotamiento tiene DOS caras que no coinciden**: el arranque de
  17:48:32 dijo literalmente `enabled but every resolved key is tombstoned
  (monthly-100); the proxy will answer 503 for every request` y el de 19:06:44 repitió
  ese par de líneas **junto con** la línea del canal sano (2 keys, peer YES). La
  conciliación medida: el aviso es sobre las claves GO (`0 key(s)` en el `listening`),
  no sobre la pata peer que sirve ⇒ **el texto «503 for every request» es MÁS AMPLIO
  que el hecho**; queda anotado, **sin adjudicarle el defecto**.
- **Activos que NO caducan en este bloque**: `HALT` (m-2333) sigue siendo la ÚNICA
  condición de pausa total y su umbral es de clave; el `reserve` es `null` y
  `billingDown` es `null` en el instante leído. Las cifras del 09-08 de arriba
  (46/74/74%, oc-15 41.8%) quedan **SUPERSEDED y marcadas**, no borradas.

## 5. BACKLOG

- **LOS DOS ENCARGOS DEL HOST DE HOY 2026-09-22 (uno CERRADO aquí, otro EN COLA)**:
  - **(1) `work-register-sync` — ✅ CERRADO por esta misma entrada**: encargo del host
    `m-1261` (19:45Z), lane `builder-468` despachada 19:48:12.955Z, ejecutada en el
    árbol `/home/esuarez/projects/deepartments` y entregada como **esta ENTRADA 2026-09-22
    del bloque superior** + el bloque **«COLA VIVA DEL IPD»** de §1 + **«ESTADO VIVO
    2026-09-22»** de §3 + **«CAPACIDAD VIVA»** de §4 + el arreglo de los **dos
    encabezados que declaraban vigencia falsa** (§3 «estado al 09-09» y §4 «al 09-08»).
    **NO commiteado por mí por diseño** (los commits son del host).
  - **(2) job `server-hygiene` — EN COLA, NO abierto** (encargo `m-1261` §3; dueño IPD;
    brief: `docs/departments/internal-programming/jobs/server-hygiene.md`, que **a
    2026-09-22T20:23Z NO EXISTE** — `ls` lo confirma: el directorio de jobs tiene 8
    ficheros y no está). Qué debe medir/actuar: **disco raíz** (leído por mí
    **20:13:29Z: 84%, 30G/38G**), **`/tmp/dsh-spill-*`** (cuenta + bytes; ⚠️ **mi
    toolset NO puede listar `/tmp`** — `dept_exec` deniega `/tmp` como cwd o ruta y
    `glob` no enumera directorios ⇒ el job necesita la vía que hoy no tengo: **la
    cifra del cron (155 dirs / 2,0G) es DECLARADA, no medida por mí**), **`archive/`**
    (`du` leído: **436M** en `/opt/dsh/.dsh-dev/archive`, **sin retención**), journals,
    stateDir y los ficheros de cuarentena. Cadencia: diaria o 6 h (decide el head).
    **🔴 LA REGLA QUE NO SE NEGOCIA (y es el criterio de aceptación principal, más que
    los topes)**: **NUNCA borrar evidencia de un incidente abierto** — antes de
    borrar, comprobar si la ronda/fichero es referencia de una ficha `abierto`/
    `en-estudio`; si lo es, **PRESERVAR y reportar** (precedente: la ronda
    `20260918T062134Z`, salvada fuera del ciclo de retención y hoy en
    `/opt/dsh/preserved-evidence/` con md5 origen==copia
    `3ea1a106cbb39c21d87b555f9d095c1d`). No duplica `reports-snapshot` (aquél copia
    INFORMES; éste mira el SERVIDOR).

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
- **COLA NUEVA 09-09 (register-sync cierre de ola, IPD builder-227 — 4 ítems breves;
  detalle en la ENTRADA de cierre arriba):**
  - **(i) lane higiene job-runs (clase O3-b/auto-heal no-fire) — CERRADO 09-09
    (lane «re-ancla cron digests + higiene job-runs», builder-229 dfe6e38a)**: RE-ANCLA
    quality-daily `'0 8 * * *'` → `'0 11 * * *'` (11:00Z, confirmado quality-head
    m-3935/3937) y daily-ai-news `'0 9 * * *'` → `'30 11 * * *'` (11:30Z, confirmado
    research-head m-3938) — ambos fuera de PEAK efectivo 00:30-10:30Z (org.pacing +
    espejo dsh-key-pooler peakWindows 01:00-04:00 ∪ 06:00-10:00 + peakBufferMs
    1800000; espejo SIN ajuste, solo anotado). NO-FIRE INVESTIGADO: el idempotency-
    skip «quality-daily-8 ya corriendo» (ts 1788940821442 = 08:00:21.442Z 09-09) fue
    un INTENTO REDUNDANTE contra el worker LIVE de la ronda cron 08:00:17Z EXITOSA
    (quality-daily-8 materializado 08:00:17.952Z, round completado 08:23:16Z m-3601,
    retirado por QD 08:23:19.355Z — posts-retired-archive prunedAt 1788942199355);
    el stamp job-runs quality-daily:1788940817887 es CORRECTO (ronda del día, nada
    stale que limpiar; digest 09-09 reporte 2026-09-09-quality-daily.md completado).
    FIX DE CÓDIGO: NO aplica — runningJobWorker ya excluye workers retirados
    (spawn.ts:331 `retired !== true`) y el latch zombie offline está cubierto por el
    P-LATCH (tools.ts:4733, boot+drain); forzar un cambio rompería la idempotencia
    real (nunca 2 workers vivos del mismo job). Ver reports/builder/2026-09-09-
    reanchor-digests-dfe6e38a.md.
  - **(ii) fb-300/fb-301 rematerialización post-smart_restart NO reconstituye toolset —
    CERRADO 09-09 (`853c12e`, builder-242 2a975be5, reviewer-126 PASS `7d18f18a`,
    m-4184)**: toolset reassertion OWN-LAYER clase worker+head — boot heal
    runToolsetReassertion (tools.ts:5193-5230) + guard ramo-live en materializePost
    (delivery.ts:1346-1366), probes own-layer discriminadoras, disposed GATEADO por
    running (fb-301), 0 exports nuevos (parity 327); registro/preset-pass
    post-restart; **records QD fb-300/fb-301 CERRADOS conjuntamente con evidencia
    post-commit** — cola §5 (ii) CERRADA con el CIERRE DE JORNADA.
  - **(iii) wording preset host — EN COLA (decisión del host)**: precisar CRITICAL
    RULE 2 + Workflow step 4 (ask_user_question «Non-negotiable» vs DELEGACIÓN TOTAL
    `90a06dc`) — lane BAJA staged próxima rotación (deploy-time).
  - **(iv) hot-patch fb-251 persistencia upstream — EN COLA**: el hot-patch node_modules
    (pi-ai overflow.js + compaction-basic:803) se pierde en reinstall; candidato
    upstream register.
- **REGISTER-SYNC PENDIENTE (quedan para el siguiente register-sync de bloque)**:
  UX fb-loop FASE 2 (dedupe/UX del loop de feedback, tras la FASE 1 `2164944` 09-08)
  · candidato-3 fb-253 (siguiente mejora del mark-delivery, tras el CLI `5ab20ea`)
  · refs cruzadas fb-308/fb-309 (journal-writer finalizeSessionLog vs la familia
  fb-309 de sesión — cotejo pendiente). No absorbidas en el CIERRE DE JORNADA 09-09.
  · **NUEVO (2026-09-22, declarado con su forma honesta)**: **`doc-drift` TIENE JOB Y NO
  TIENE SU PRIMER INFORME** — `docs/departments/internal-programming/jobs/doc-drift.md`
  (194 líneas, mtime 2026-09-22T16:30:30Z, `schedule: '0 11 * * 1'`, outbox
  `reports/reviewer/<YYYY-MM-DD>-doc-drift-<token>.md`) entró con `e845baf` 18:00:36Z,
  pero **`find` sobre `/.deepartments` y sobre el repo NO encuentra ningún informe
  `*doc-drift*`** (medido 20:23Z) ⇒ **la doc viva debe su PRIMERA verificación**; el
  primer lunes en que dispare es **2026-09-28** (día de la semana verificado con `date`).
  · **Y `docs/WHERE-TO-LOOK.md` tiene delta SIN COMMITEAR** en el árbol de trabajo
  (`git diff --stat` 20:23Z: +70 líneas solo), igual que `docs/departments/internal-programming/HOST-SAMPLER.md`,
  `packages/dshd-health/src/index.ts`, `scripts/host-sampler.mjs`, `src/index.ts`,
  `test/host-rotation-fallback-trace.test.js`, `test/host-sampler.test.js` y el nuevo
  `test/heap-band-truth-2ebbc0de.test.js` — **es trabajo de lanes vivas (Lane A/`heap-band-truth`),
  no residuo**; se anota para que el cierre de bloque no lo lea como suciedad.
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
- **DOCTRINA — UN DISPARADOR DE CALENDARIO QUE LLEVA UNA PREMISA FALSA LA EJECUTA:
  SE CORRIGE EN LA ENTRADA, NO EN UN MENSAJE (2026-09-23, IPH; doctrina + caso medido)**:
  corregir el texto de un disparador no basta, porque **la retractación tiene RADIO DE
  DAÑO** — el alcance de lo que ya incorporó la premisa: el propio disparador, los briefs
  YA enviados a workers y los resúmenes que la citan. **Una regla sin su caso es un
  aforismo; con su caso, es citable.**
  **CASO MEDIDO**: el disparador de calendario de las **15:00Z** del 09-23
  (`/.deepartments/calendar.json`, entrada `e6edea28-2b35-4200-9715-4fb809ee10ed`,
  `createdBy internal-programming-head`, creada
  `ts MEDIDO: 1790171305440 = 2026-09-23T13:48:25.440Z`) llevaba la premisa **falsa** de
  que la edición de `packages/dshd-orchestration/src/tools.ts` exigía **re-freeze**; la
  **ENTRADA** se corrigió — y hoy declara, en su propio texto, «**NO EXIGE
  RE-FREEZE**» y «**RETIRADA LA PREMISA FALSA**». La medida que la funda está en el §
  de esta misma entrada: la zona congelada es el **slice** entre los centinelas de
  `tools.ts:5783` y `tools.ts:7708`, y `tools.ts:2908` **queda FUERA** (md5 del slice
  `f7ed6986b8c89fa625910e3566b51fbd` por dos instrumentos que coincidieron).
  **Ninguna entrada ajena se reescribe por esto**: la retractación vive donde se leyó la
  premisa.
- **DOCTRINA — AL CITAR UNA MEDICIÓN PROPIA SE DECLARA `medido a <ts>`, NUNCA «medido
  ahora» (2026-09-23, IPH; doctrina + caso medido)**:
  **CASO MEDIDO**: una cifra que **envejeció 72.650 s** entre la lectura y el envío del
  **MISMO** agente ⇒ «medido ahora» era falso en el momento de escribirlo, y no había
  forma de saberlo sin el `ts`.
  **EXTENSIÓN PROBADA — EL `seq` DELATA LA COPIA**: **el `seq` de un bloque que NO se
  re-mide es el sello de que se está citando una lectura VIEJA**; la prueba de la jornada
  es que el **mismo `seq 3748`** se citó en **TRES** mensajes distintos, y ésa —no el
  contenido— era la señal de que no se había vuelto a medir.
  ⚠️ **COROLARIO PARA ESTE REGISTRO**: un margen (o cualquier cifra viva) se cita **con
  su `seq`**, nunca como número suelto — un número sin su `seq` no es verificable. El
  margen VIEJO del IPH (`{seq 3748, pressureTokens 313728}`) quedó **SUPERSEDED** por el
  suyo medido para el mensaje de la jornada (**`{seq 3930, pressureTokens 388373}`**) —
  y la forma correcta de citarlo es **con ese par**, no con la resta.
  ⚠️ **LÍMITE DECLARADO (no re-medido por mí)**: esos dos pares `{seq, pressureTokens}`
  son **telemetría del PROPIO agente** (`agent_pressure`/context-action del harness), **no
  campos de un artefacto que yo pueda releer**: `/.deepartments/tool-intents.jsonl` tiene
  **2.821 filas** con claves `kind,id,tool,agent,memberId,target,args,ts` y **0 filas con
  `seq` o `pressureTokens`** (medido en esta ventana) ⇒ **en este registro se citan como
  DECLARADOS por el IPH, no como medición mía**; lo verificable aquí es la FORMA
  (`{seq, pressureTokens}`, nunca la resta), que es lo que la doctrina exige.

---

## 8. DEFAULT-FLIP de la cola (`d46d84b7`) — porqué, y el LÍMITE del instrumento de verificación

> **Registrado por el Asistente (host `15f80d86`), 2026-09-21T19:2xZ.** El cambio entró
> en `main` con el commit **`c572779`** **sin su razón escrita en el mensaje** (lo
> clasifiqué como «operador» — error mío de atribución). Este apartado cierra esa deuda:
> `main` no debe tener un cambio de COMPORTAMIENTO sin su porqué. Texto construido con la
> redacción del IPH y **sus mediciones re-verificadas por mí en fuente**.

### 8.1 El síntoma (encargo textual del owner)

> «la cola no se drena sola… lo sigue haciendo uno a uno… hay 12 queued».

### 8.2 La causa, medida

El flag `batchEligible` tenía **un solo origen**: `send_message`
(`packages/dshd-orchestration/src/tools.ts` —
`const batchEligible = noWake === true || args.interrupt === true ? false : true`).
**Toda otra clase productora** — avisos del daemon de salud, avisos de agenda/scheduler,
avisos de post-error — entregaba **1:1 a un destinatario RUNNING pese a usar el mismo
transporte**. Medido en la sesión viva: la clase marcada daba **0,391 turnos/mensaje**
(9 items → 23 mensajes) y la no marcada **1,000** (8 → 8); **el flag era la única
diferencia**.

### 8.3 El cambio

Una costura pura `isBatchEligible(opts)` en `packages/dshd-core/src/delivery.ts`:
**el flag explícito GANA** (`false` = opt-out 1:1 · `true` = opt-in);
**AUSENTE = ELEGIBLE**, salvo `noWake`/`interrupt`. La usan el gate fb-117, el transporte
ALWAYS-WAKE y el registro del ledger.

**El opt-out explícito es deliberado y está medido:** `packages/dshd-orchestration/src/delivery.ts`
(`deliverBusRecord`, la **costura de RECUPERACIÓN** — el re-drive de arranque y el sweep de
pares aparcados) pasa `batchEligible: false`. Con el flip dejado elegible,
`test/wake-seam-mitigation.test.js` **caso 14** (O1 B3 sweep-dormancy) se puso **ROJA**: un
re-drive a un host corriendo **se acumulaba en vez de ATERRIZAR** y sus pares quedaban
`prepared` hasta el timeout. **Un re-drive existe para CERRAR un par tardío**: diferirlo a
un flush recrea el par aparcado que el sweep venía a resolver. Con el opt-out: **14/14**.

### 8.4 🔴 EL LÍMITE DEL INSTRUMENTO DE VERIFICACIÓN (leer ANTES de verificar el despliegue)

El flip añade `batchEligibleDeclared` (`absent` | `true` | `false`), el campo que distingue
un `false` **deliberado** de un flag **ausente**. **PERO es LOG-ONLY — no va al ledger.**
Verificado por mí en fuente:
- `packages/dshd-core/src/delivery.ts:802` — el `logger.info` **SÍ** lo lleva.
- `:814-833` — `appendGateLedgerRow({…})` **NO** lo lleva (sus campos son
  `kind, at, id, recipient, seq, gated, materialized, runningLive, batchEligible, noWake,
  interrupt, headNoWake, awaited`).

⇒ **Quien verifique el despliegue grepeando `batchEligibleDeclared` en
`gate-decisions.jsonl` obtendrá 0 SIEMPRE — con el código viejo Y con el nuevo — y
concluirá «el fix no cargó» teniéndolo cargado.** El criterio correcto va **partido por
campo**:
- **`batchEligible=true`** ⇒ **SÍ está en el ledger** (`:823`) ⇒ sirve para ver que un
  aviso del daemon pasó a elegible.
- **`batchEligibleDeclared`** ⇒ **es la LÍNEA DEL LOG**, la que lleva
  `FB467_INSTRUMENTATION_STAMP`.

### 8.5 Verificación post-reinicio (lo único que falta)

El **build** está hecho: `grep -c isBatchEligible packages/dshd-core/lib/delivery.js` ⇒ **6**
(antes 0 ⇒ el «INERT» del informe `d46d84b7` está **caducado**). Falta **sólo el reinicio**.
Orden: (1) build → hecha; (2) la **línea del LOG** con `batchEligibleDeclared=` presente
(código nuevo cargado) **y** `batchEligible=true` en el ledger para un aviso del daemon;
(3) re-medir el ratio de la clase sin-flag contra el **1,000** de línea base.

### 8.6 Límite de alcance — dicho, no rebajado

**La aceptación del owner (N encolados ⇒ ≈⌈N/lote⌉ turnos) NO es alcanzable para todas las
clases:**
- **El chat del owner NO es una entrega del bus** (es input del harness:
  `{"kind":"user","rpcId",…,"clientTimeZone"}`) ⇒ **ningún flag de este repo le aplica**.
- **El 1:1 estructural es el `Inbox.claim` del HARNESS**: `next-step` reclama la lista
  ENTERA y **`next-turn` reclama EXACTAMENTE 1**
  (`…/dsh-agent/lib/types/inbox.js:51-53`, ruta ANIDADA bajo `@deepseek-ai/dsh`) ⇒ está
  **fuera de este repo**: se eleva al owner de DSH, no se parchea aquí.

### 8.7 Discrepancia declarada (para que no se herede)

El informe `d46d84b7` afirma «`test/batch-drain.test.js` **17/17** (3 corridas)».
**Medido en 6 pasadas: 17/0 · 16/1 · 17/0 · 17/0 · 17/0 · 16/1** ⇒ **~2/6 fallan.**
**Tres pasadas limpias no establecen 17/17.** El rojo está **capturado y nombrado**:
`FB-258 (tool, C1): deliveredAt() …` en **`test/batch-drain.test.js:859`**,
`expected 1790017547320 / actual 1790017547305` ⇒ **carrera de RELOJ (15 ms), no de
lógica**; **preexistente** (`75cba35`, fb-258, builder-198) y **el diff del flip NO la
toca** ⇒ **no la rompió el fix: la destapa el reloj**. **NO se arregla ablandando la
aserción**: `delivered === pairRows[last].ts` es un oráculo de **coherencia** legítimo; el
problema es el reloj.

**Referencias:** informe fuente `reports/builder/2026-09-21-cola-no-se-drena-d46d84b7.md`
(run `d46d84b7`) · redacción del porqué
`reports/2026-09-21-iph-cola-documentacion-deflip.md` · commit del mecanismo `c572779`.
