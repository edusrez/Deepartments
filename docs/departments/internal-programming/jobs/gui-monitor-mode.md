---
id: gui-monitor-mode
title: GUI modo monitoreo — ocultar el composer cuando el owner está ausente (presencia global)
role: builder
description: >-
  Implementar en el cliente web deepartments (packages/dshd-gui/src/client/index.tsx) que el
  composer (cuadro de texto) se OCULTE cuando el toggle de presencia EXISTENTE («Toggle owner
  presence», header utilities) pase a MODO AUSENTE y se MUESTRE al volver a presente — GLOBAL
  (todas las sesiones/tabs). Mecanismo: CSS/DOM global sobre el data-attr del harness
  [data-composer-seat] + poll 5s de presence/get (cadencia/gating del watcher U3) + aplicación
  inmediata local tras presence/set. Solo-UI (affordance), aceptado por la decisión del owner.
  NO incluye el tab de presencia de la org (feature (b) — DESCARTADO por el owner) ni el
  hardening server-side de /api/session.prompt (hardening posterior documentado). Base de diseño:
  reports/explore-deep/2026-09-02-gui-monitor-scoping-e2134a39.md y
  reports/explore-deep/2026-09-03-gui-monitor-mode-seam-b485e663.md (seam file:line exacto).
owner: internal-programming-head
outbox: reports/builder/<YYYY-MM-DD>-gui-monitor-mode.md
---

# GUI modo monitoreo (composer ↔ presencia del owner, GLOBAL)

## Decisión del owner (cerrada — NO reabrir)

- **SÍ**: el composer (cuadro de texto) se OCULTA cuando el toggle de presencia existente
  («Toggle owner presence», esquina superior derecha) pasa a MODO AUSENTE; se MUESTRA al volver a
  presente; GLOBAL (todas las sesiones/tabs de la GUI).
- **NO (descartado explícitamente)**: el tab/panel de presencia de la ORG (feature (b) del scoping
  2026-09-02 — estado dept_who en la GUI). NO implementar.
- **NO (descartado formalmente)**: la variante per-viewer host-only (inviable sin upstream: la GUI
  no autentica al viewer).
- **Aceptado**: solo-UI (affordance). El enforcement server-side es hardening POSTERIOR (ver abajo).
- El modo = la presencia del OWNER (`presence.json present:false` vía el toggle existente). NO crear
  un estado/modo GUI nuevo ni un toggle nuevo.

## Alcance (leer primero — seam file:line exacto en el reporte FASE 0 citado arriba)

1. **Un solo archivo fuente**: `packages/dshd-gui/src/client/index.tsx` (deepartments-client — ya
   toca el toggle, ya tiene el poll 5s y ya registra slots). 0 cambios server (presence/get|set,
   presence.json y el route-lock de 6 rutas quedan intactos). Sin bundle client nuevo, sin fila
   nueva en el grafo (CLIENT-ROW RULE), sin caras nuevas de inject.
2. **Ocultar REAL**: inyectar UNA vez (apply) un `<style id="dsw-deepartments-monitor-style">` con
   `.dsw-deepartments-monitor [data-composer-seat] { display: none !important; }` y togglear la body
   class. El seat `[data-composer-seat]` (dsh-client-ui-conversation lib/client.js:7266-7271)
   envuelve todo el input stack (composer bar + hero + approval) en todas las fases/sesiones.
   Precedente de inyección <style> global en el viejo client (git ff9e2c4^). El texto del cuadro
   NUNCA se muestra: display:none, no disabled.
3. **Driver de presencia**: (a) poll ligero de `presence/get` — misma cadencia 5s + focus/visibility
   gating que el watcher U3 (index.tsx:415-486) con seed en apply (default present → visible);
   (b) aplicación INMEDIATA local tras un presence/set exitoso del toggle (función módulo-scope
   compartida con PresenceToggle, index.tsx:502-590). Exportar una función pura
   `shouldApplyMonitorMode(present)` (y lo que el test necesite) para unit-test vm.
4. **Límite documentado en el código y el reporte**: solo-UI/affordance — session.prompt queda
   callable (dsh-host-apiproxy lib/index.js:2261-2268); el toggle en el header permanece visible y
   explica el estado; el approval panel queda oculto mientras absent (aceptable).

## NO hacer (non-goals)

- NO el tab/panel de presencia de la org (feature (b) descartada por el owner).
- NO el hardening server-side en esta lane (ver «Hardening posterior»).
- NO tocar la dist/source del harness, el shell, ni la metadata dsh.client del bundle.
- NO romper el watcher U3 (host/status), la Agenda (conversation.view) ni el toggle de presencia.

## Hardening posterior (documentado, NO en esta lane)

Sombra exact-route de `/api/session.prompt` mientras presence=absent: exact gana al prefix /api
(dsh-host-webserver lib/index.js:270-279; /api = prefix de dsh-client-connection lib/index.js:550-562);
montar/desmontar dinámicamente (register → disposer :132-134) en las transiciones de presencia
(enganchar al presence/set dispatch, dshd-gui src/index.ts:362-396) respondiendo el envelope
`{type:'server-response',rpcId,result:{ok:false,error:{code:'owner-absent',…}}}` (reusar
readRequestBody/parseClientEnvelope/respondJson de dshd-gui src/index.ts:543-674). NO hay
delegación al /api handler → la ruta solo existe mientras absent. Actualizaría el route-lock del
smoke-boot (test/smoke-boot.test.js:129-150) y el log del mount (dshd-gui src/index.ts:838-840).

## Build y tests

- Build del cliente (obligatorio tras tocar index.tsx):
  `pnpm --filter dshd-gui run build:client && node scripts/mirror-client.mjs` (mirror byte-idéntico).
- Tests nuevos (patrón vm del bundle real — test/client-watcher.test.js:34-69): extender ese archivo
  o crear `test/client-monitor-mode.test.js`: funciones puras del modo + drive de apply() con rpc
  presence mockeado y sandbox document con `head.appendChild`/`body.classList`; assert del body class
  tras poll (absent) y tras poll (present).
- Suite completa: `pnpm test` (el dispatcher presence ya está cubierto — invoke.test.js 9397-9630;
  route-lock 6 rutas — smoke-boot.test.js:129-150, DEBE seguir en 6).

## Canary (verificación manual GUI :3090)

1. Build + mirror ok, suite verde.
2. Reinicio del canary del profile dev (el profile sirve el repo por symlink —
   `/opt/dsh/.dsh-dev/profiles/deepartments-dev/node_modules/dsh-deepartments`).
3. Manual: presence present → composer visible en todas las sesiones; toggle Absent → composer
   oculto en ≤5s en todas las sesiones/tabs (instantáneo en el tab del toggle); toggle Present →
   vuelve; el toggle, la Agenda y la rotación host/status siguen operativos.

## Reporte

`reports/builder/<YYYY-MM-DD>-gui-monitor-mode.md`, frontmatter proyecto (`agent: builder`, `date`,
`task`, `spec_ref: docs/departments/internal-programming/jobs/gui-monitor-mode.md`, `outcome`,
`files_touched`, `error_type`, `key_findings`), cuerpo: qué se cambió (index.tsx), mecánica
file:line, tests, canary. 0 commits (reporta al head). Revisa el estado de presence.json y del
bundle servido en el canary. Referencias ≤3: los dos reports explore-deep citados arriba.
