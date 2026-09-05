# VERIFICATION-LADDER — convención canónica de la suite (fb-95 / fb-91 / fb-115)

> Referencia breve del LADDER de verificación del repo. Fuente de verdad de la
> convención de tests: `AGENTS.md` § TIERED verification + `docs/specs/001` §
> Verification ladder. Este doc consolida (R6, 2026-09-05): el método canónico
> de la suite (fb-95), el guard de integridad de suite (fb-91) y la lección de
> proceso de rotación (fb-115). Aplica a builders, reviewers y cualquier run.

## 1. Ladder de tests — método canónico (fb-95, SRC-NATIVE)

El `--loader ./test/ts-src-loader.mjs --test` como DEFAULT de toda la suite
produce FALSOS FAILS en la familia composición/Loader incluso con el árbol
limpio (fb-95, verificado 2026-09-04: smoke-boot 5/7 CON hook vs 7/7 SIN hook,
misma instancia).

**Padrón canónico:**

| Contexto | Comando |
|---|---|
| Suite completa (default) | `pnpm test` = PLAIN `node --test` sobre el `lib/` COMPILADO |
| Suite + guard de integridad (fb-91) | `pnpm test:guarded` (node --test plano envuelto por `scripts/r6-suite-guard.mjs`) |
| Tests lane-② src-native | SON EXCEPCIÓN: el propio test se AUTO-REGISTRA el hook (`register(new URL('./ts-src-loader.mjs', import.meta.url), …)`) y se ejecutan bajo el mismo `pnpm test` plano — nunca con `--loader` CLI |

Regla: `node --test` plano sobre `lib/` es el único default; `--loader` es
solo la auto-registración de los tests lane-② (`test/r6-ladder-flat.test.js`
blinda esto: ningún script de package.json puede contener `--loader`).

## 2. Guard de integridad de suite (fb-91)

fb-91 (2026-09-04): la suite se auto-mutó `packages/dshd-orchestration/src/tools.ts`
±1B a mitad de run (zona CUT-4 78050↔78051B; el freeze 7b5b1c91… solo cuadraba
post-rewrite; el árbol quedó restaurado al final) — escritor no identificado
(investigación R6: NINGÚN test escribe ese archivo; los únicos writers al árbol
son los fixtures git-HEAD-restored de `presets/departments/research/*` en
invoke.test.js; la clase más plausible = edición concurrente de otra lane en el
árbol compartido, p.ej. el re-freeze R4 `6e3936c` el mismo día). El detector que
faltaba:

```bash
pnpm test:guarded        # snapshot ANTES → node --test plano → verifica DESPUÉS
```

Detecta (y FALLA) tres clases:

1. **START**: el archivo guardado difiere de git HEAD al arrancar (árbol ya
   mutado / no-quiet). Escape hatch de árbol compartido (WIP de otra lane):
   `R6_GUARD_SKIP_START=1 pnpm test:guarded` (solo salta el check de START; los
   de DURING/END siguen activos). Verdicto autoritativo = árbol quieto.
2. **DURING** (polling 400 ms): cualquier cambio del md5 CUT-4-zone durante el
   run — el caso write+restore del propio fb-91 — falla con timestamp del evento.
   Un cambio del archivo entero FUERA de la zona CUT-4 se reporta como evento
   informativo (clase WIP de árbol compartido: `tools.ts:1313/1400-1600/5593-5635`
   son zonas legítimas de otras lanes), no falla.
3. **END**: el archivo debe quedar byte-idéntico a su snapshot de inicio.

La zona CUT-4 es la MISMA que fija el test congelado `tools-factory.test.js`
(markers `messaging bus TOOL DEFINITIONS` → `deepartments: host-plane tools`,
leída desde el SOURCE `packages/dshd-orchestration/src/tools.ts`); el guard y el
freeze comparten presa. Ver también `test/r6-tree-integrity.test.js` (higiene
standalone: árbol vs git HEAD con skip por WIP, + selftest hermético del
detector).

## 3. Lección de proceso — rotación de head (fb-115)

`dept_head_rotate` rechaza correctamente una rotación cuyo target NO está idle/
running en el momento de ejecutar (validación correcta por diseño: el rechazo
orienta y protege). Lección de proceso formalizada: **re-check de `dept_who`
INMEDIATAMENTE antes de rotar** — una lectura de roster "confirmó listo" puede
quedar stale (el target entró running/otra operación en curso). Rutina segura:
`dept_who` (fresh) → confirmar target idle → `dept_head_rotate` → verificar el
rotado. El rechazo es señal de coordinación, no bug.

## 4. Baseline de la suite (referencia para reviewers)

- Método: `pnpm build` + `pnpm test` (plano sobre lib) — o `pnpm test:guarded`.
- Baseline HEAD (R6, 2026-09-05): **832/796/14/22** (varianza documentada
  828-832 total). Fail-set ESTABLE = 12 por nombre: F2 regression · M2.1/2.3/2.4 ·
  B2 x3 · M-A SMOKE · A3/C2 postsRetention · head-sleep rotation-race (d) ·
  PR-2 W7-A settle · fb-11 (2) ZERO REGRESSION — deuda POR ENTORNO/legacy, NO
  arreglar. Fails adicionales por entorno/demonio (pasan aislados, fallan en
  suite completa — varianza observada 12-14): O1-EXT P2 (outbox drain),
  P7 (TDD RED guard). REGLA: 0 regresiones — mismos fails por nombre, 0 nuevos.
- Un run nuevo SIEMPRE: `git status` limpio al empezar y al terminar; `tsc root`
  (pnpm build) verde; commit solo de los archivos de la lane.