# WORK-REGISTER — trabajo pendiente

> Registro TOTAL de trabajo pendiente de la organización Deepartments. Creado
> el 2026-08-27 (M3 SYNERGY-DOCS, decisión owner) a partir del contenido v1 del
> Asistente; lo mantienen el **Internal Programming Department (IPD)** y el
> **Asistente**. Es la fuente de verdad de la cola: IPD activa, DAG técnico
> cerrado, decisiones pendientes del owner, capacidad, backlog y sinergias.

## 1. IPD — cola activa

- **M4** watchdog de inactividad del sistema (owner, alta — si 15-30 min sin
  agente running con pendientes → alerta) · **M2.3** secretary en heads (3
  smokes fallidos M2/M2.1/M2.2; instrumentación en vivo del standing pedida al
  IPD) · seguimiento log-sweep del QD (objetivos nuevos → misiones).

## 2. DAG técnico — CERRADO (referencia)

PASO 9 (c5131af) · fb-6 (32d6314) · F-HIGH (630a59c) · fb-7 pooler (3d55bbf) ·
A+B (408f1c6) · M1 (6f638d4) · M2 (274d550) · E2-IMPL (e09e687) · M1.1
(7172b19) · M2.1 (6416a34) · M2.2 (3e47993) · C12+O2+fb-8 (d94f5ea) ·
M3 (f159eda).

## 3. PENDIENTE-OWNER (decisiones)

- D5 (formalizar 3 plugins ocultos / re-exposición subagent — REVISAR alcance
  tras M2: el seam cambió a secretary) · apiKey DeepSeek (diferida) · publish vs
  link-only · stable 3080 upgrade (dshmarket 1.21.2→1.33.0; constraint
  no-tocar-stable) · tool goal a retirar · oc-5 WIP absorbido en 3d55bbf
  (¿commit aparte? nota QD) · E1 opcionales RD (seam tools: extend quirúrgico /
  acotar write a reportDir) · web_search en scope secretary (smoke del deploy lo
  decide; fuera del allow por diseño).

## 4. CAPACIDAD

- oc-11 monthly 5% (sana) · oc-10 libre (16:57) · oc-6/8/9 hasta 08-31 salvo
  top-up · vías RD (reports/researcher/2026-08-27-capacity-provider-options.md)
  · watchdogs M1 activos.

## 5. BACKLOG

- ~~flake 1b.1 (:4686)~~ ~~m-64 intermitente~~ ~~fb-8 (flag deliverable)~~ —
  **DONE** (de-flakeados en C12+O2, commit d94f5ea; 0 skips, cobertura
  preservada) · fb-2/fb-3 QD · comentario stale dshd-health:31-32 · dshmarket
  1.33.0 dev (bundlear en próximo deploy) · B6/B7 (revisar obsoletas con A+B).

## 6. SINERGIA

Flujos head↔head operativos (m-422): IPD→RD, QD→RD, RD proactivo (tech-watch +
análisis de fallos). M3 los institucionaliza en docs/skill.