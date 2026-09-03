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

## 1. IPD — cola activa (DAG seriado, lección fb-20: UN lane a la vez)

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
  - **GUI modo monitoreo (owner 09-01) — SCOPING CERRADO 09-02
    (reports/explore-deep/2026-09-02-gui-monitor-scoping-e2134a39.md) +
    OWNER-GATED (parqueado — build NO iniciado)**: el harness NO expone la
    presencia org al client-inject (solo sesiones propias vía WS/SSE); la GUI no
    tiene identidad de viewer (fence no-auth; session.prompt callable) →
    «composer oculto solo-a-no-host» = upstream/auth (NO plugin-alcanzable);
    opciones org-side recomendadas: B1 presencia org (endpoint
    /deepartments/presence/list + tab, ~0.5-1d) + A1 modo monitoreo GLOBAL
    (composer bloqueado server-side, ~1-2d); A2 (auth/roles) = upstream. Decisión
    owner pendiente (canal cerrado 09-02 → §3). Job doc borrador en §7 del
    scoping (id gui-monitor-mode).
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
    kind-ack m-2518/m-2520 no contados como confirmación por el mirror m-2524;
    candidato lane mirror/transporte: reconocer kind-ack de confirmación como
    «confirmación explícita»)** — en cola.
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
  - **LANE DEL INCIDENTE 09-03 (cadena IPH, secuencial — UN lane a la vez)**:
    ① **clasificador 401-invalid: DESPLEGADO 2x (09-03 18:23 73d8922 + 18:46
    hotfix 402 0a9cdc7 — ambos canary PASS; lib live)**: sweep convergió
    (oc-8/9/11/12 quota-blocked hasta 09-23..28), completion real 200,
    **oc-10 FUERA por hot-block (billingBlocked, invalid:true; nextProbeAt
    ~24h; el fix 402→billing-block con auto-heal resolve el gap probe-vs-real
    del finding post-deploy)** → **LATCH JUBILADO (09-03, confirmación IPH
    verificado: oc-10 fuera, oc-6 valid probe 200, 0 post-error 429→to:null —
    el gate-clean MANUAL queda RETIRADO; clasificador + age-check por código
    absorben su función)** → ② **delivery lane commits 1-4 — EN VUELO (HIGH,
    arrancada 09-03: age-check R1 resolvePoolerDispatchBlock :3069-3077 + seam
    spawn.ts:355-387 + expo at/stale-age + alerta usable>0&&stale preservando
    el intent 7f634ef para 429 frescos · re-drive no-boot-only · fb-79
    backoff/max-attempts + caso worker→own-head idle · fb-58 settle
    prepared→terminal + re-routing rotatedTo (caso F-3) · O1 retire-grace/
    marker · umbrales §7.5)** →
    ③ **stable :3080 (owner AUTORIZÓ 09-03 — §3
    RAG-stable sentinel)**.
  - **settings revert (provider→opencode-zen con Go vivo)** — coordinar con IPH
    (bandeja owner abierta). · **job-runs primitiva** — en cola IPD.
  - **familia transporte (fb-23/69/70/81 send abort pre-dispatch sin
    persistencia → fb-58 mirror lane)** — en cola (datapoints QH 09-03: ack
    prepared-stuck m-425 + fb-83 4º abort hoy — clase AMPLIADA de mensajería
    (send_message/memo) a tools de OPERACIÓN (bash); consolidado en notas fb-81).
    **fb-58 recidiva DOBLE (veredicto QD 09-03): F-1 m-2236 65-min stuck + F-3
    FRESCA: m-424/425/429 → host retired 66031134 quedaron 'prepared' x2 sin
    terminal — settle del sidecar SIN implementar.** + **F-4 LIVE 09-03:
    m-410 → quality-head sin inicio 10 min con idle (mission-stalled —
    nudged always-wake; despierta y drena).** + **F-5: drenaje de cola del IPH
    post-boot (18:46+): acks STALE del handoff previo asentándose al procesar
    la cola (2+ recibidos; el LATCH real queda detrás del drain — los
    prepared viejos se procesan al despertar, el settle del sidecar sigue
    pendiente).** Cierre formal familia
    fb-69/70/81/m-425 = lane ② + 48h de 0 failed (criterios §7 reporte QD).
  - **fb-78 A1+A2+A3 (post-restart: re-aplicación smokes vía API + lane)** —
    **A1 CERRADO (09-03, lane builder-2 PASS; reporte
    reports/builder/2026-09-03-smokearchive-hideset-api-d7fe08ee.md)**: los 4
    ids (291b7fa4/d051ef54/b979e1db/bad24e6c) en archivedSessionIds del
    workspace.json vivo (grep líneas 1614-1617, hunk único +4; diff post =
    SOLO ese hunk, keyPooler-state intacto) vía **API canónica
    (POST /api/workspace.archiveSession — fb-82**; la lane previa de
    builder-36 fue edit directo → perdido en reseed, causa raíz documentada);
    sesiones reales verificadas; re-call idempotente; restart NO necesario;
    0 commits/0 edits. **A2/A3 pendientes**.
  - **fb-64 (execRoots + stateDir READ-ONLY — aditivo) — scoping documentado
    (`b05d75a`, opción C — ARCHITECTURE.md execution scope; NOTE comment-only en
    fixture fb-62); verificación pendiente** · GUI monitor owner-gated parqueado.
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
  **fb-63/66/67** (6feff49).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · F-HIGH (630a59c) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) · M3
(f159eda) · D5 (b239b4a) · P1 (448697b) · release 0.1.0 (efd579b) · PASO 1-3 +
tools SB1-4 + presets SB6 + boot Z7 (decoupling HITO 3 — f28c719) · M-5
(f3ec445) · M-6 (79da4f2) · fb-29 (4695145) · VALLE bloque A/B/C (0dbf645 /
b2ecb45 / c59e1ab) · hardening-401 (66399ad + 7248a55) · fb-27 (04f8c31).
Fase modular 0.2.x = solo BACKLOG/owner (§3/§5).

## 3. PENDIENTE-OWNER (decisiones — estado al 09-02)

- **GUI modo monitoreo (owner 09-01) — DECISIÓN PENDIENTE (canal cerrado 09-02,
  owner ausente)**: scoping CERRADO (reports/explore-deep/2026-09-02-gui-monitor-
  scoping-e2134a39.md): ¿A1+B1 org-side (modo monitoreo global + presencia org,
  plugin-first, 0 upstream) o A2 upstream (auth/roles para no-host selectivo)?
  Recomendación IPD: A1+B1 ahora + A2 roadmap. Job doc borrador listo (§7 del
  scoping, id gui-monitor-mode). Parqueado hasta veredicto.
- **fb-66 (head sin edit) — write-only intencional DECLARADO (resuelto por
  diseño; cambio de HEAD_BASE_TOOLS invoke.ts:2348 = decisión owner si algún día
  se quiere edit para el head)**.
- **port upstream fb-51 (PR deepseek-harness `packages/fs/tool-fs-search`)** —
  go-ahead del owner; safety copy del fix en tmp/port-harness-fb51-ca5df751/
  (workspace IPD, hashes verificados); acción del HOST (clone/PR/rebuild del
  monorepo — no construible desde los roots del lane).
- **billing top-up CRÍTICO → GESTIONADO 09-03 (workaround con backup)**: la key
  real del OWNER (opencode-go, chat-auth 200) en oc-6 salva el pool; oc-8/9/10/
  11/12 en cooldown (monthly resets 23-28/09); top-up real sigue sin decisión.
- **:3080 + stable-update (19 releases pendientes)** — actualización estable
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
  el watchdog system-health; cierra con el landing.)
- **glm-fallback vía OpenRouter → DESCARTADO (owner 09-01)** — la flota sigue
  100% DS; el veredicto de fondo (ruta opencode-go es el cuello, no la key)
  queda como conocimiento del RD (reports/researcher/2026-09-01-consolidated-
  telemetry-glm-retest.md).
- **top-up ws10/oc-6 → NO por ahora (owner 09-01)** — varias keys con buena
  capacidad; se retoma cuando las keys se agoten (watch del pool).
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
- CERRADOS: publish 0.1.0 (efd579b) · D5 · P1 · tool-goal retirado · API key
  DeepSeek (fallback real) · restart 05:23:31Z (owner: ignorar — watch si
  reaparecen; restart-registry lo deja visible) · cause restarts 08-31
  explicada (switch glm + reversión).

## 4. CAPACIDAD (al 09-03)

- Pool: **oc-6 = key real del OWNER (opencode-go, chat-auth 200 — la única
  real; selectable) — salva el pool tras el incidente 09-03** · oc-8/9/10/11/12
  en **cooldown mensual (resets 23-28/09)** — **LATCH JUBILADO 09-03 (el
  gate-clean manual RETIRADO; clasificador + age-check por código absorben —
  confirmación IPH con convergencia verificada)** · **POST-DEPLOY 09-03 18:23-18:35:
  oc-8/9/11/12 quota-bloqueadas automáticamente (monthly 100%, blockedUntil
  09-23..28); OC-10 HOT-BLOCKED (billingBlocked + invalid:true + errorClass
  401 — front A de builder-6 aplicado; la poison 402 queda fuera de selección);
  lastRotation FRESCA con to≠null → branch 3 del gate NO re-armada (R1 sigue
  por el age-check de la lane ②); usable = oc-6 (R3 estructural)** ·
  DS-fallback a api.deepseek.com
  LIVE (c4a04bc) · fall-through 401/429 (bb22b20) · gate poolerGateEnabled
  (hardening 66399ad — live tras deploy).
- Lección 09-03: **usage 200 ≠ chat-auth** (verificación de keys contra el
  adaptador/chat, no la API raw) — el clasificador 401-invalid formaliza la
  distinción 401/billing vs 429/monthly.
- Límites conocidos: **= 1 usable / 6 keys (CRÍTICO — gate hardening-401
  PAUSA despachos nuevos desde 09-03; se reanuda al recuperar capacidad) —
  la única real es oc-6; el resto oc-8/9/10/11/12 = quota/auth (resets
  09-23..28)** · wrk_01KYW76T8 a cero desde 08-31 — **owner (a la vuelta):
  la decisión de top-up de keys es AHORA RELEVANTE** (al 09-01 "varias keys
  con buena capacidad" era el espejismo del health-check viejo; la verdad =
  1 key real → o top-up o pipeline en pause hasta 09-23..28).
- Watchdogs M1 activos + M-4/M-5/M-6/M-7 + context-threshold (M-A) +
  pooler-capacity (hardening 66399ad — live) —
  auto-observación completa del runtime.

## 5. BACKLOG

- **O2 del QD (09-03, dirigido a host/runtime) — nudge spliced a posts RETIRED
  sobre abort de vida → dead-letter**: cuando un agente aborta por razón de
  vida (abort/kill), el feedback-nudge (tools.ts post-execute, live desde
  09-02) splicea a posts retirados → mensajes a recipient retirado = dead
  letter. Propuesta QD: excluir los aborts de vida del nudge O no splicear a
  posts retired. **DECISIÓN IPH 09-03: 'nudge-handler: excluir aborts de vida
  / no splicear a retired (tools.ts post-execute) — lane pequeña POST-②,
  PLEGABLE AL FOLD-IN de fb-78'** (ambas tocan tools.ts — un solo toque al
  archivo; dead-letter es O2/bajo, no bloquea; se adelanta si QH la repunta).
  + **mejora watchdog: mission-stalled (10-min) dispara falso positivo sobre
  entregas no-wake-gated por diseño (records bajo de feedback al QH drenan al
  próximo wake — caso m-410/fb-89) — considerar excluir no-wake del detector**.
- **Rotación host m-423 PARTIAL (veredicto QD 09-03)**: el archive de
  dept_sleep corta ~85 líneas de la cola zombie final (incl. m-426 delivered
  post-retirement; acks a host rotado 'prepared') — candidato fix IPD
  (completar archive/settle del sidecar). · **Residuo live-handle**: builder-2
  retired:true en posts.json pero running en dept_who — higiene IPD (revisar/
  retirar handle).
- **Hueco pre-existente zombie rule (dsh-key-pooler — OBSERVADO en lane
  clasificador 401 09-03, NO arreglado, byte-idéntico preservado)**: probe
  403-region-gate sobre key clase-401 sobrescribe errorClass→'403' en
  probeInvalidKeys — candidato lane pooler post-deploy. (Mejora aparte: falso
  positivo dept_exec en grep con patrón /models\) → reportada al QD por el
  builder.)
- ~~flake 1b.1~~ ~~m-64~~ ~~fb-8~~ — DONE · ~~comentario stale dshd-health~~
  DONE (PR-1) · ~~fb-25/26/27/28~~ — fb-25 (2b5a370) ✓ / fb-26 práctica ✓ /
  fb-27 ✓ (04f8c31) / fb-28 🔵 en vuelo · ~~fb-30~~ INVESTIGADO (diseño-no-bug;
  catch-up durable = lane 4) · ~~fb-29~~ IMPLEMENTADO (4695145 + lane B b2ecb45)
  · ~~fb-32~~ señal consolidada (3 ANALYZEs) para refinar detector del guard
  — candidato IPD post-DAG · ~~fb-39/40/41/42/43/44/45/46/47/48~~ — fb-39 ✓
  (hardening) · fb-40/41 convención adoptada (verificación QD) · fb-42
  watch-class · fb-43 ✓ (0dbf645) · fb-44 filed (researcher sin edit —
  candidato preset) · fb-45/46/47/48 prácticas/normas QD+host (ver ROADMAP
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
  verified-at en reports explore-deep · **fb-37** job-def quality-daily real ·
  **fb-24** KB dominio→mirror · **fb-26** zstd-con-cap práctica ✓ ·
  **fb-33** tests que mutan preset reales (restore en finally) · **O3** nota
  en spec 005 §3.4 ✓ (knowledge).
- **core DSH 0.1.2-alpha — WATCH owner** (peers trap `^0.1.1-rc.0` en
  dsh-deepartments/smart-restart/tool-web-enhanced → ERESOLVE si se mueve el
  host; dshmarket 1.39.0 ya 0.1.2-ready; smooth-stream 0.4.3 aplicada a disco).
- **Versions**: dshmarket 1.39.0 dev ✓ (live) · smooth-stream 0.4.3 a disco
  (live-load próximo arranque) · npm dsh-deepartments 0.1.0 publicado ✓.

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