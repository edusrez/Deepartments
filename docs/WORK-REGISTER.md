# WORK-REGISTER — trabajo pendiente

> Registro TOTAL de trabajo pendiente de la organización Deepartments. Creado
> el 2026-08-27 (M3 SYNERGY-DOCS, decisión owner) a partir del contenido v1 del
> Asistente; lo mantienen el **Internal Programming Department (IPD)** y el
> **Asistente**. Es la fuente de verdad de la cola: IPD activa, DAG técnico
> cerrado, decisiones pendientes del owner, capacidad, backlog y sinergias.

## 1. IPD — cola activa

- **M4** watchdog de inactividad del sistema (owner, alta — si 15-30 min sin
  agente running con pendientes → alerta; **IMPLEMENTADO 2026-08-27 por
  builder-4 — kind `system-idle` en dshd-health (scan + ledger propio
  system-idle-state.json + frame) + knobs `systemIdleEnabled`/`idleWindowMs`
  900000 en org.ts + dep `hostRunning` en el wiring + 8 tests M4 — pendiente
  commit del Asistente**) · **M2.3** secretary en heads (3
  smokes fallidos M2/M2.1/M2.2; instrumentación en vivo del standing pedida al
  IPD) · seguimiento log-sweep del QD (objetivos nuevos → misiones).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · F-HIGH (630a59c) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) ·
M3 (f159eda).

## 3. PENDIENTE-OWNER (decisiones)

- D5 → BACKLOG fase modularización 0.2.x (formalizar 3 superficies Cordis del
  bundle: patch-row / subagent-subpath (secretary) / client-inject; R6 no
  borrar) · apiKey DeepSeek → RESUELTO 08-28 (key platform existente = FALLBACK
  del pooler; alta/top-up a validar con owner — consola dio 403 en research RD)
  · publish vs link-only → DECIDIDO 08-28: publish 0.1.x (próxima ventana
  release; owner delega al host) · stable 3080 upgrade → NO TOCAR (owner 08-28)
  · tool goal → RETIRADO 2026-08-28 (fila fuera del preset durable dev; efecto
  runtime en ventana de deploy; nota R6 en preset) · keys Go adicionales
  (PENDIENTE-OWNER compra: RD 7-8 keys flash = $70-80/mes, NO malgasto; 1-2 keys
  insuficientes solas) · oc-5 WIP absorbido en 3d55bbf (¿commit aparte? nota QD)
  · E1 opcionales RD (seam tools: extend quirúrgico / acotar write a reportDir)
  · web_search en scope secretary (smoke del deploy lo decide; fuera del allow
  por diseño).

## 4. CAPACIDAD

- oc-11 monthly 5% (sana) · oc-10 libre (16:57) · oc-6/8/9 hasta 08-31 salvo
  top-up · **oc-12 REGISTRADA 2026-08-28 (otra cuenta opencode → cuota
  independiente; drop-in key-pooler, sin workspace; ACTIVA tras la ventana de
  deploy — pooler lee env al boot)** · vías RD
  (reports/researcher/2026-08-27-capacity-provider-options.md)
  · watchdogs M1 activos.

## 5. BACKLOG

- ~~flake 1b.1 (:4686)~~ ~~m-64 intermitente~~ ~~fb-8 (flag deliverable)~~ —
  **DONE** (de-flakeados en C12+O2, commit d94f5ea; 0 skips, cobertura
  preservada) · fb-2/fb-3 QD · comentario stale dshd-health:31-32 · dshmarket
  1.33.0 dev (bundlear en próximo deploy) · B6/B7 (revisar obsoletas con A+B).

## 6. SINERGIA

Flujos head↔head operativos (m-422): IPD→RD, QD→RD, RD proactivo (tech-watch +
análisis de fallos). M3 los institucionaliza en docs/skill.