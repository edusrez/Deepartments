# WORK-REGISTER — trabajo pendiente

> Registro TOTAL de trabajo pendiente de la organización Deepartments. Creado
> el 2026-08-27 (M3 SYNERGY-DOCS, decisión owner) a partir del contenido v1 del
> Asistente; lo mantienen el **Internal Programming Department (IPD)** y el
> **Asistente**. Es la fuente de verdad de la cola: IPD activa, DAG técnico
> cerrado, decisiones pendientes del owner, capacidad, backlog y sinergias.
> **LANDING 2026-08-28 (PR-1, docs/ledger pasada C3 del QD + ANEXO owner 8
> ítems)** — PENDIENTE-OWNER al día, adicionales QD/owner aterrizados.
> **LANDING 2026-08-28 (2ª pasada)** — riesgo condicional RAG-stable (§3) + filas backlog rag_index/tsc-drift + lección fb-20 aterrizados.

## 1. IPD — cola activa

- **M4** watchdog de inactividad del sistema (owner, alta — si 15-30 min sin
  agente running con pendientes → alerta; **IMPLEMENTADO 2026-08-27 por
  builder-4 — kind `system-idle` en dshd-health (scan + ledger propio
  system-idle-state.json + frame) + knobs `systemIdleEnabled`/`idleWindowMs`
  900000 en org.ts + dep `hostRunning` en el wiring + 8 tests M4 — pendiente
  commit del Asistente**) · **M-A MONITOR de contexto** (owner, alta — scan/
  kind `context-threshold` en dshd-health con umbral 50% (knob
  `contextThreshold` 0.5) + dedupe por BANDA `context-threshold:<id>:bN` (cruce
  de banda → alerta inmediata; banda persistente → re-alerta 30 min por la
  dedupe shared, sin ledger propio) + poll `contextThresholdPollMs` 60000
  (patrón per-minute) + dep opcional `sessionContexts` construida por el bundle
  leyendo `ctx.sessionProjections.snapshot(session).values.contextPressure` (la
  vista wire, versión-agnóstica RC.7/RC.2) + knobs org.ts + 9 tests incl. smoke
  real → frame al host — **IMPLEMENTADO 2026-08-28 por builder-27, pendiente
  commit del Asistente**; la rotación-por-umbral para heads es la SEGUNDA
  misión M-A (tool dept_head_rotate — aterrizada en el worktree pendiente de
  commit) · **M2.3** secretary en heads (3
  smokes fallidos M2/M2.1/M2.2; instrumentación en vivo del standing pedida al
  IPD — **residual M2 documentado tal cual**: handle residente + smoke live
  heads pendientes del deploy del subagent/secretary) · seguimiento log-sweep
  del QD (objetivos nuevos → misiones) · **PR-1 docs/ledger ATERRIZADO
  2026-08-28** (este landing) · **dsh-vanilla** = unidad DEcommissioned
  conocida (el job system-health-report la trata **warn-NO-escalate**; el
  Asistente verificó **is-enabled = disabled** en el unit, 2026-08-28) ·
  **PACING peak/valle** (owner, MEDIUM — pacing/coste: el gate reduce el 429
  y el coste; la org ya vive en modo ráfaga; **IMPLEMENTADO 2026-08-28 por
  builder-28 — módulo puro pacing.ts en dshd-core (fórmula UTC espejo del
  dsh-key-pooler, ref-cruzada por comentario) + knobs `org.pacing.*` (enabled/
  peakWindows weekday×hours/peakBufferMs 1800000) + sección `## Pacing
  (franja)` en el wake pack (host + lean snapshot) + avisos de transición del
  daemon (canal notifyHost durable + dedupe key `pacing-transition` en el
  health-alerts ledger + baseline durable pacing-state.json; primer arranque
  = solo baseline, sin aviso — documentado) + política en skill/WORK-REGISTER
  — pendiente commit del Asistente**).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · **F-HIGH (630a59c) — CERRADO** (fuera de
PENDIENTE-OWNER; fila solo de referencia) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) ·
M3 (f159eda). Fase modular 0.2.x (siguiente, solo BACKLOG/owner — §3/§5).

## 3. PENDIENTE-OWNER (decisiones)

- **D5 → IMPLEMENTADO 2026-08-29 por builder-8 (pendiente commit del Asistente;
  ver .dsh/reports/ipd/2026-08-29-modularization-d5.md)**: formalizar las 3
  superficies del bundle + fold de flags baratos — (1) patch-row deepartments:
  fila formal verificada (cordis.patch.yml:3-5) + doble fuente de verdad de org
  resuelta SIN cambio de comportamiento (dshd-core = SHARED SOURCE, bundle =
  FALLBACK MIRROR; parity test test/org-config-parity.test.js fija stateDir /
  departments / poolerBaseURL + one-sided keys documentadas) · (2) subagent-
  subpath → secretary: tool-secretary PROMOVIDO a fila Cordis formal ÚNICA en
  el repo (presets/deepartments-head/agent.cordis.yml; matiz temporal/smoke del
  twin headless retirado del perfil dev, R6 nada retirado) · (3) client inject:
  dshd-gui = OWNER de la superficie deepartments-client (build/normalize ÚNICO;
  el ./client del bundle se PRESERVA como espejo byte-idéntico via
  scripts/mirror-client.mjs; raíz tsdown.config.ts + normalize-client-banner
  duplicados FOLDED) · (4) flag stale «dshd-core NOT composed today» corregido
  (sí se compone; compose-first en los perfiles dev). R6 intacto (stable
  /opt/dsh/.dsh NO tocado) · **P1 → IMPLEMENTADO 2026-08-29 por builder-9
  (pendiente commit del Asistente tras reviewer PASS; ver
  .dsh/reports/ipd/2026-08-29-modularization-p1.md)**: plugin-izar los 6
  packages-LIB (feedback/gui/health/jobs/pooler/quality) hasta superficie
  Cordis REAL — (1) CADA uno con name/inject/apply + fila cordis.patch.yml
  propia + servicio `deepartments.*` (feedback store / quality emitter / jobs
  scheduler tick / pooler boot check / health daemon tick / gui channel) con
  las deps INYECTADAS vía el Binder FASE 2.6 (deepartments.org + deepartments.
  binder; las 6 capas compuestas en el perfil dev; dep ausente al USE →
  FAIL-LOUD R1, nunca silencioso) — SEMÁNTICA de los bridges same-module
  SUSTITUIDA por composición SIN retirar los 20 bridges (eso es el hito
  DECOUPLING) ni tocar applyInvoke · (2) peers en package.json (cordis +
  dshd-gui→dshd-jobs, dshd-health→dshd-core/dshd-quality — el flag del audit;
  deps workspace conservadas R6) · (3) dump-config perfil dev: 6 capas nuevas
  `# == dshd-*` compuestas con secciones core/deepartments BYTE-IDÉNTICAS
  (postsRetention core-only, pacing/quality bundle-only, poolerBaseURL espejo)
  · (4) bundle componible en MODO MÍNIMO (8 packages + deepartments, verificado
  en perfil temporal) · (5) plugin add OK (scopeteado en perfil temporal del
  dev HOME) — suite 619/597/0/22 EXACTA, builds raíz+8+client exit 0, git diff
  --check limpio · apiKey DeepSeek →
  RESUELTO 08-28 (key platform existente = FALLBACK del pooler; alta/top-up a
  validar con owner — consola dio 403 en research RD) · publish vs link-only →
  DECIDIDO 08-28, **PENDIENTE DE EJECUCIÓN**: publish dsh-deepartments 0.1.x en
  la próxima ventana release (owner delega al host; **con la feature
  pacing/coste** — coordinar con la ventana) · stable 3080 upgrade → NO TOCAR
  (owner 08-28) · **RIESGO CONDICIONAL RAG-STABLE (decisión (b) aceptada
  2026-08-28)** — el perfil ESTABLE /opt/dsh/.dsh monta el plugin
  dsh-tool-web-enhanced ANTIGUO (pre-denylist/excludePaths); RagEngine.
  ensureIndex hace AUTO-INDEX en cada boot (única ruta de ingesta, clase fb-15:
  claves API vivas en claro en el índice). Si el stable arranca, un re-index no
  intencionado puede re-ingerir secretos. **Decisión: RIESGO ACEPTADO +
  documentado** (el stable NO se re-bootea; vigilancia), con la guarda
  **SENTINEL-PENDIENTE**: cuando/si se toque /opt/dsh/.dsh → (i) desactivar el
  auto-index del RAG (config/sentinel) O (ii) actualizar su plugin a
  0.4.0-rc.1+denylist ANTES del primer boot. NO se toca /opt/dsh/.dsh en esta
  misión · **METR → nada** (cubierto por el tech-watch del RD, sin
  acción IPD) · tool goal → RETIRADO 2026-08-28 (fila fuera del preset durable
  dev; efecto runtime en ventana de deploy; nota R6 en preset) · keys Go
  adicionales (PENDIENTE-OWNER compra: RD 7-8 keys flash = $70-80/mes, NO
  malgasto; 1-2 keys insuficientes solas) · oc-5 WIP absorbido en 3d55bbf
  (¿commit aparte? nota QD) · E1 opcionales RD (seam tools: extend quirúrgico /
  acotar write a reportDir) · web_search en scope secretary (smoke del deploy
  lo decide; fuera del allow por diseño) · **capacidad/DeepSeek → research RD
  EN CURSO, recalibración ABIERTA — NO cerrar** (reports/researcher/
  2026-08-28-deepseek-access-alternative.md + 2026-08-27-capacity-provider-
  options.md; ver §4).

## 4. CAPACIDAD

- oc-11 monthly 5% (sana) · oc-10 libre (16:57) · oc-6/8/9 hasta 08-31 salvo
  top-up · **oc-12 REGISTRADA 2026-08-28 (otra cuenta opencode → cuota
  independiente; drop-in key-pooler, sin workspace; ACTIVA tras la ventana de
  deploy — pooler lee env al boot)** · vías RD en curso
  (reports/researcher/2026-08-28-deepseek-access-alternative.md —
  **recalibración ABIERTA, NO cerrar**; + reports/researcher/
  2026-08-27-capacity-provider-options.md) · watchdogs M1 activos.

## 5. BACKLOG

- ~~flake 1b.1 (:4686)~~ ~~m-64 intermitente~~ ~~fb-8 (flag deliverable)~~ —
  **DONE** (de-flakeados en C12+O2, commit d94f5ea; 0 skips, cobertura
  preservada) · **fb-2/fb-3 QD — AGENDADAS** (fb-2: render dept_sleep en sleep
  EXITOSO; fb-3: latencia noWake de directivas a cabezas dormidas — en cola QD,
  sin ejecutar todavía) · ~~comentario stale dshd-health:31-32~~ — **DONE
  (PR-1)**: el header decía «the QD quality gate (Lote Q)» STAYED en
  src/invoke.ts cuando la gate DECISION vive en dshd-quality — actualizado a
  la realidad post-extracción (solo call-sites/emitter quedan en el bundle) ·
  **F3 — ítem POST-SECUENCIA marcado por ownership explícito**: barrido de
  sesiones worker huérfanas (`worker-*` sin post — Dx1 F3, deliberadamente
  fuera del pase F2: un sweep no-post no puede distinguir un huérfano org de
  otra sesión; backlog 0.2.x) · **O3 — firma NORMAL del retire**: el último
  tool result de un worker retirado puede salir «tool call aborted» tras el
  disposed (persistido+delivered ANTES, NUNCA pérdida; muestra 7/7 del QD) —
  nota de conocimiento en docs/specs/005 §3.4 · **core DSH 0.1.2-alpha.1 —
  WATCH ítem owner** (GitHub-only, no en npm; nota ROADMAP FUTURO del monitor:
  modelos por departamento vía subagent selection, fold nativo vs smooth-stream
  auto-collapse, one-time-token/Tailscale en URLs de red, ApiProxy removido →
  @Remote, telemetría del adaptador DeepSeek, trap ERESOLVE con peers
  ensanchados `|| ^0.1.2-0` antes de mover el host) · dshmarket dev actualizado
  **1.33.0 → 1.35.0** (08-28; dev current, exact pin; stable sigue NO-TOCAR) ·
  B6/B7 (revisar obsoletas con A+B) · **rag_index 300s timeout
  (dsh-tool-web-enhanced)**: la tool `{}`,`{timeoutMs:300000}` indexa TODAS las
  databases; revisar el cap / configurabilidad — ref
  reports/explore-deep/2026-08-28-rag-secret-exclusion-map.md ·
  **tsc-drift dsh-tool-web-enhanced**: drift build src/lib pre-existente
  (WebSearchArgs/Config — revisar en la fase E1/0.2.x; ref
  reports/builder/2026-08-28-rag-rebuild-unique-fix.md:159) · **lección fb-20
  (proceso, NO código)**: builders concurrentes en la MISMA zona de edits
  colisionan (caso b29/b30 dshd-health) → serializar por zona o asignar zonas
  disjuntas — anotado 2026-08-28. · **fb-27 (QD, ALTO/mejora, 2026-08-29)**:
  sin notificación automática del turn/end-error al head ni re-despacho — caso
  real builder-4: stream-idle 300s + 4× 502 ETIMEDOUT → 502 21:50:14Z tras
  completar TODO el trabajo; el cierre quedó 8h14m pendiente hasta un wake
  manual. Candidato a implementar: notificar turn/end-error al head con
  sessionId+turn — HABILITADO por la proveniencia (b) del fb-25 (recién
  aterrizada); el re-despacho queda como consideración de diseño; verificación
  del QD al aterrizar — ref dshd-health (dominio runtime). · **fb-28 (QD,
  MEDIO, 2026-08-29)**: «colisión de ruta de reporte al reusar un postId» —
  caso builder-5: slug reutilizado tras un retire → su ruta de reporte
  colisionó con la del worker ANTERIOR; filed por el QD con naming D-Q6. A
  revisar al implementar: la derivación del reportDir por postId/slug en el
  respawn de un slug retirado, para evitar colisiones (p.ej. sufijar por
  sesión o limpiar/archivar el reporte previo).

## 6. SINERGIA

Flujos head↔head operativos (m-422): IPD→RD, QD→RD, RD proactivo (tech-watch +
análisis de fallos). M3 los institucionaliza en docs/skill.

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