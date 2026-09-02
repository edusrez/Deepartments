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

## 1. IPD — cola activa (DAG seriado, lección fb-20: UN lane a la vez)

- **POST-DAG — cola nueva (DAG del IPH):**
  - **DI-by-services CERRADO (73f60d9, deploy canary 11:17Z — MISIÓN 8/8)**:
    muerte TOTAL del binder register → holders baseline service-first (P1 0
    ctx.provide; md5 CUT-4 `5b548545` intacto; suite 724/702/0/22 EXACTA);
    dept-as-plugin DESBLOQUEADO.
  - **fb-57 (provider-400 'function.arguments must be valid JSON', ALTO —
    escalado al IPH, m-2204)**: ≥2 workers distintos en <24h (q-i-6 +
    ai-industry-news-2); fix candidato: sanitizar tool-call args en el adapter
    / autogate reintentos N=2 con respawn de sesión fresca.
  - **F6 (ancla recursión D-Q2)**: no muestrear inspector cuyo managerId sea
    inspector QD, o desvío a workers NO-QD pasados N niveles — fix runtime en
    el emitter (m-2170 del QH).
  - **fb-50 (calibración M-A** capacidad efectiva + completion-reserve) ·
    **fb-51/52 (glob literal-segment false-negative + guard aritmética)**.
  - **feedback-nudge (opción B**, waterfall tools/post-execute) · **GUI modo
    monitoreo (owner 09-01**: composer oculto no-host + toggle presencia —
    verificar si el harness expone la presencia al client-inject) · **higiene
    dir huérfano reports**.
- **CERRADOS en esta cola (no pedir de nuevo):** M4 (system-idle),
  M-A (context-threshold + dept_head_rotate), PACING (peak/valle),
  M-5 (misión-sin-inicio), M-6 (main-red), M-7 (mission-queue),
  fb-43 (restart-registry), fb-39 gate (hardening 401 — 66399ad + pooler
  7248a55), fb-27 (turn/end-error notify — 04f8c31), materializePost cold
  re-spawn (b2ecb45), pulse-digest (c59e1ab), MEMO NORM (c59e1ab + docs RD),
  **fb-28** (37e9315 + QH close), **de-flake W6/BugA + fb-30** (8dcfc47),
  **fb-46 watchdog work-register-idle** (ee0effd), **fb-47 mejoras de sistema**
  (a5a27a7), **0.2.1 P6** (81ef5cd), **0.2.2 P1+P4** (9cda995), **fb-55**
  (5210682), **0.2.3a/b/c** (e8222af/dc9f79a/48cea9f — MISIÓN 7/8).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · F-HIGH (630a59c) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) · M3
(f159eda) · D5 (b239b4a) · P1 (448697b) · release 0.1.0 (efd579b) · PASO 1-3 +
tools SB1-4 + presets SB6 + boot Z7 (decoupling HITO 3 — f28c719) · M-5
(f3ec445) · M-6 (79da4f2) · fb-29 (4695145) · VALLE bloque A/B/C (0dbf645 /
b2ecb45 / c59e1ab) · hardening-401 (66399ad + 7248a55) · fb-27 (04f8c31).
Fase modular 0.2.x = solo BACKLOG/owner (§3/§5).

## 3. PENDIENTE-OWNER (decisiones — estado al 09-01)

- **glm-fallback vía OpenRouter → DESCARTADO (owner 09-01)** — la flota sigue
  100% DS; el veredicto de fondo (ruta opencode-go es el cuello, no la key)
  queda como conocimiento del RD (reports/researcher/2026-09-01-consolidated-
  telemetry-glm-retest.md).
- **top-up ws10/oc-6 → NO por ahora (owner 09-01)** — varias keys con buena
  capacidad; se retoma cuando las keys se agoten (watch del pool).
- **stable 3080 → NO TOCAR (owner 09-01)** — confirmado en presencia; el item
  del RD (monitor dsh-updates) queda cerrado con ese veredicto.
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

## 4. CAPACIDAD (al 09-01)

- Pool: oc-11 monthly 5% sana · oc-12 (otra cuenta, cuota independiente)
  ACTIVA · DS-fallback a api.deepseek.com LIVE (c4a04bc) · fall-through 401/429
  (bb22b20) · gate poolerGateEnabled (hardening 66399ad — live tras deploy).
- Límites conocidos: oc-10 workspace bloqueado hasta 09-07 · wrk_01KYW76T8 a
  cero desde 08-31 (evidencia del outage 401) — owner: no urgente (top-up no
  por ahora).
- Watchdogs M1 activos + M-4/M-5/M-6/M-7 + context-threshold (M-A) —
  auto-observación completa del runtime.

## 5. BACKLOG

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
- **PROCESO CONSOLIDADO (QD 09-01, confirmado ×2 en job workers del research:
  deepseek-dsh-news-3 + ai-industry-news-4) — propagar jobId/contexto de ronda
  al mensaje del worker en rounds monitor-driven** (sin ello la MEMO NORM no se
  activa — el worker no sabe que es job worker y razona «Finish — ephemeral»).
  Routing: research/IPD (construcción del mensaje del monitor/job runner).
  + **convención fecha UTC** (frontmatter/nombres en UTC, no local — patrón
  +1 día ×2 hoy). Post-B (o que el research-head lo tome si lo ve claro).
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
