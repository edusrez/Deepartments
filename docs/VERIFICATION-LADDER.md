# VERIFICATION-LADDER — convención canónica de la suite (fb-95 / fb-91 / fb-115 / fb-190)

> Referencia breve del LADDER de verificación del repo. Fuente de verdad de la
> convención de tests: `AGENTS.md` § TIERED verification + `docs/specs/001` §
> Verification ladder. Este doc consolida (R6, 2026-09-05): el método canónico
> de la suite (fb-95), el guard de integridad de suite (fb-91), la lección de
> proceso de rotación (fb-115 + la sub-norma de rotación en silencio fb-190,
> §3.1), el aislamiento de review en worktree (A4-2, §5), la convención de
> rutas absolutas de reports (fb-140, §6) y el procedimiento de commit-hold
> (HOLD-P0, §7). Aplica a builders, reviewers y cualquier run.

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

### 1.1 El criterio de la familia lane-② es una PROPIEDAD, no una FOTO (fb-1063/#1095 — resuelto 2026-09-17)

El test 3 de `test/r6-ladder-flat.test.js` blindaba la convención comparando
`registerers` (derivados del árbol) contra `laneFamily`, un `Set` CONGELADO de 19
entradas con su sello `LANE2_FAMILY_PHOTO_AT`: el rojo lo disparaba la FECHA DE
NACIMIENTO de un fichero, no una propiedad del producto (medido: 9
auto-registradores posteriores a la foto, ninguno de ellos defectuoso ⇒ fb-1063
NO-FALLO del producto / DEFECTO DEL INSTRUMENTO). Re-declarar una foto nueva
habría re-armado el mismo rojo con la lane siguiente: lo que cambió es EL
CRITERIO.

**Criterio vigente (símbolos del mismo test):**

- `builtLibSpecifiersOf(fichero)` — **la propiedad**: un auto-registrador cuyos
  specifiers de import (`from`, `import(…)`, `require(…)`) alcanzan un árbol
  `lib/` CONSTRUIDO no es lane-② src-native ⇒ **ROJO**, salvo que el fichero
  esté nombrado en `LANE2_BUILT_LIB_EXCEPTIONS`.
- `LANE2_BUILT_LIB_EXCEPTIONS` — **las excepciones van NOMBRADAS Y CON RAZÓN**:
  cada entrada declara POR QUÉ su helper tiene que ser el artefacto construido
  (hoy 4: `fb957-settle-cause`, `lane2-retire-grace-zombie`, `o1ext-lane`,
  `ipd-orphan-quiescent-reap-8deea5ac`) — una entrada sin razón es ROJA, y una
  excepción que ya no describe el árbol (fichero ausente, o que dejó de importar
  el `lib/`) también.
- `reachesSrc(fichero)` — **la mitad positiva del nombre**: el fichero debe
  alcanzar la FUENTE (un specifier a un árbol `src/`, o el bundle
  `src/index.ts` nombrado en el fichero).
- `LANE2_SRC_NATIVE_BASELINE` (+ `LANE2_SRC_NATIVE_BASELINE_AT`) — la lista pasa
  a ser **BASELINE DECLARADA Y REPORTADA** (una línea de diagnóstico que el
  propio test imprime) y **NUNCA el criterio**: un fichero nuevo src-native NO
  pone el guard rojo.

**Dientes demostrados, no prometidos.** Un auto-registrador que importe el
`lib/` construido sin estar en las excepciones ⇒ RED + exit 1 (prueba de
inyección, retirada después); y un fichero NUEVO src-native del mismo porte deja
el guard en exit 0, sólo REPORTADO como posterior a la baseline.

**Ampliar la familia — lo que ya NO hay que hacer:** un test nuevo src-native no
obliga a tocar ninguna lista; si importa el `lib/` construido, la decisión es de
su autor — rutear el import a `src` o declarar la excepción CON su razón.

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

**Limitación conocida (2026-09-05, builder-107 b48b3e05):** las tres fases del
guard son de MUTACIÓN (START worktree-vs-HEAD · DURING poll 400 ms · END vs
snapshot de inicio) — **ninguna** compara `zoneMd5` contra el valor congelado
(que vive solo en `tools-factory.test.js:348`). El guard protege contra
mutación MID-RUN del span (fb-91) pero **NO contra deriva POR COMMIT** (zona
cambiada en un HEAD nuevo: worktree==HEAD deja las tres fases en verde; esa
capa es el freeze test `tools-factory`, que relee el source en cada run).
**Mejora candidata OPCIONAL (no implementada hoy):** asertar
`zoneMd5(start) === freeze` en START vía un MANIFEST compartido del valor
congelado — cierra la clase de observabilidad por commit a nivel CI. El caso
MAIN-RED 2026-09-05 resultó FALSO POSITIVO (lock nunca rojo; el md5 del span en
HEAD era byte-idéntico a 7693beaa) — la mejora no habría cambiado ese veredicto,
pero elimina el punto ciego diagnóstico (diagnóstico completo del guard:
builder-107 b48b3e05 §4).

## 2.5 Pre-flight de coherencia pines↔catálogo — paso 2.5 TIERED (guard `MPC-PREFLIGHT`, familia fb-42 subclase C1)

> **Paso TIERED NUEVO.** Se intercala en la ladder de `AGENTS.md` § TIERED
> verification entre el paso 2 (`dsh plugin … add`) y el paso 3
> (`--dump-config`), y es **BLOQUEANTE** antes de cualquier fase live (escritura
> del catálogo/presets vivos) y antes de cualquier `smart_restart`.
> **Referencia cruzada: `AGENTS.md` regla 11** (invariante I-MP — todo pin
> resuelto por el runtime existe en el catálogo vivo del provider en TODO
> instante, incluido el estado intermedio de un changeset; catálogo
> ADITIVO-FIRST; fase live contigua antes del único restart; la regla-orden es
> necesaria pero NO suficiente). Spec y aceptación del guard: §4.2 (A1-A8) de
> `.dsh/reports/quality/2026-09-10-incidente-congelacion-modelo-prevencion.md`.

**Qué comprueba.** El invariante I-MP sobre el **conjunto** de pines `P` (no
una sola ruta) contra los **catálogos vivos** `C`:
`∀ (provider p, model m) ∈ P : m ∈ C(p)` — y, por separado,
`p ∈ registeredProviders` (clase NO_ADAPTER, se reporta distinta).

Tramos de `P` (cada uno con evidencia del incidente 09-10):

| # | Tramo | Fuente canónica |
|---|---|---|
| P1 | `agent-default-model` | `settings.yaml` vivo + `cordis.patch.yml` raíz + presets |
| P2 | filas de coordinador + `org.workerAgentOptions`/`org.hostAgentOptions` | `--dump-config` del perfil (`packages/dshd-core/cordis.patch.yml` + mirror `-min`) |
| P3 | constantes `WORKER_AGENT_OPTIONS`/`HOST_AGENT_OPTIONS` | **importadas del bundle** (`packages/dshd-orchestration/src/presets.ts`) — cero drift por literales duplicados |
| P4 | presets live | `.agent-presets/**` del home dev |
| P5 | handles persistidos de sesiones vivas | **el pin RESUELTO POR TURNO**, nunca la fecha de nacimiento del sessionId |
| P6 | presets staged/twin + plugins hermanos | `profiles/*/cordis.patch.yml` · `dsh-key-pooler` |

Lado `C`: `settings.yaml` → `llm-pi-ai.providers[p].models[].id`, leído por las
DOS vías — estática (`--dump-config` del perfil) y runtime
(`ctx.get('llm').listModels(p)`, la primitiva del probe R2) — **exigiendo
coincidencia**; la discrepancia entre ambas es en sí misma un hallazgo.

**Estado de implementación (2026-09-11, lane MPC-PREFLIGHT) — el contrato de
exit del CLI `scripts/mpc-preflight.mjs`, medido:** `0` = I-MP verificado por las
DOS mitades; **`2` = BLOQUEO** en `deploy`/`check` — pares `pines ⊄ catálogo`
(evidencia positiva), **ninguna fuente estática legible**, **la mitad RUNTIME no
consultada** (sin `llm` in-process y sin `--catalog`) o **las dos mitades
consultadas DISCREPANDO** (una resuelve el pin y la otra lo niega: el veto de un
catálogo consultado nunca queda tapado por el `ok` del otro); `3` = REJECTED por
el write-guard subtractivo; `4` = el `--catalog` nombrado no se pudo leer. La
puerta ③ (boot) **nunca bloquea**: degrada (alerta con interrupt al host vivo +
fila durable + marca) y su latch se **limpia** en el siguiente boot sano, para no
seguir anunciando DEGRADED con el árbol ya reparado.

**Dónde se ejecuta** (4 puertas, mismo núcleo puro): ① **deploy pre-flight
BLOQUEANTE** — dos ejecuciones, antes de la fase live y después de
`pnpm build`+`plugin add`, siempre **antes** del `smart_restart`: si `P ⊄ C` el
deploy **aborta** (exit ≠ 0, línea accionable con provider+model+tramo) y
**nunca** se reinicia; ② **write-guard** del catálogo: rechazar un guardado que
RETIRA un id referenciado por un pin desplegado (ADD nunca bloquea); ③ **boot**:
auto-verificación LOUD + DURABLE (alerta + finding con la lista de pares
ausentes) — no niega el arranque, pero **jamás** un «ok» silencioso;
④ **mint/materialización**: el probe R2 existente, extendido a
create/resume y con re-resolución del modelo del handle al re-materializar
(P5/fb-332).

**Qué hace al fallar:** fail-loud, nunca degradar; **prohibido el fail-open** en
las puertas ①②. El guard es **read-only estricto** (no auto-edita
`settings.yaml`, no auto-restaura legacy, no reinicia): sólo lee y bloquea/avisa.

**Criterio P5 (anti-falso-positivo, obligatorio).** El discriminador de «sesión
stranded / handle stale» es el **pin resuelto por turno** (el handle
re-resuelve al materializar), NO la fecha de nacimiento del sessionId: un head
longevo reutiliza su directorio de sesión a través de la rotación, así que el
criterio ingenuo da **4 falsos positivos permanentes** (sweep 09-10: los 3
heads con sessionId pre-fix pero turnos resolviendo `opencode-zen`/
`deepseek-flash`, 0 campos legacy; 0 stranded reales). Con ese baseline de
cero-FP se fija la aceptación A4.

**Por qué es un PASO y no un aviso.** En el incidente 09-10 pasaron **15 s**
entre la escritura live del catálogo (11:20:58.109Z) y el primer turno muerto
(11:21:12.984Z), y **83 min** hasta el build de la pierna que la hacía verdad:
la puerta de admisión puede invalidar el productor en segundos, así que la
comprobación tiene que correr en el punto de acción (escritura/deploy), no en el
plan.

## 3. Lección de proceso — rotación de head (fb-115)

`dept_head_rotate` rechaza correctamente una rotación cuyo target NO está idle/
running en el momento de ejecutar (validación correcta por diseño: el rechazo
orienta y protege). Lección de proceso formalizada: **re-check de `dept_who`
INMEDIATAMENTE antes de rotar** — una lectura de roster "confirmó listo" puede
quedar stale (el target entró running/otra operación en curso). Rutina segura:
`dept_who` (fresh) → confirmar target idle → `dept_head_rotate` → verificar el
rotado. El rechazo es señal de coordinación, no bug.

### 3.1 Sub-norma — ROTACIÓN EN SILENCIO (fb-190, 2026-09-06)

Complementa la lección fb-115 con la forma de NO auto-inducir el rechazo:

> **ROTACIÓN EN SILENCIO:** el host NO anuncia la rotación al head saliente en
> su mismo turno — el anuncio lo DESPIERTA (materialización) y
> `dept_head_rotate` rechaza con **RUNNING** (carrera auto-inducida; familia
> R8/race-liveness fb-143/144/145). Procedimiento: verificar idle REAL
> (`dept_who` con `liveStatus: idle` — la finalization tail de un head que
> acaba de declararse listo aún corre, y `dept_head_rotate` la auto-espera con
> su settle-wait 5s), re-check justo antes de rotar (práctica fb-115, supra),
> rotar EN SILENCIO, y saludar al FRESH con handoff ORIENTADOR — el
> seed/journal del saliente ES la orientación, así que el anuncio pre-rotación
> es redundante y dañino. Referencia: precedente `dept_head_rotate` settle-wait
> 5s (R8), fb-115 (re-check pre-rotate) y el ciclo welcome/handoff
> (m-2040/2041/2069 — handoff con lanes enumeradas, NO pre-anuncio). La norma
> la EJECUTA el host (único ejecutor de `dept_head_rotate`); la lane solo la
> registra.

## 4. Baseline de la suite (referencia para reviewers)

- Método: `pnpm build` + `pnpm test` (plano sobre lib) — o `pnpm test:guarded`.
  Desde 2026-09-23 `pnpm build` ES el gate de artefacto stale (§9.1, fb-2673): el
  primer eslabón verifica el `lib/` que el runtime resuelve ANTES de compilar.
- Baseline (canónico de la ronda, 2026-09-05 — verificado por reviewer-68,
  P-LATCH review bdf16217): **882/848/12/22** (previa 878/844/12/22 + 4 tests
  nuevos, todos pass; varianza documentada 877-882 total). Fail-set ESTABLE =
  12 por nombre: F2 regression · M2.1/2.3/2.4 ·
  B2 x3 · M-A SMOKE · A3/C2 postsRetention · head-sleep rotation-race (d) ·
  PR-2 W7-A settle · fb-11 (2) ZERO REGRESSION — deuda POR ENTORNO/legacy, NO
  arreglar. Fails adicionales por entorno/demonio (pasan aislados, fallan en
  suite completa — varianza observada 12-14): O1-EXT P2 (outbox drain),
  P7 (TDD RED guard). REGLA: 0 regresiones — mismos fails por nombre, 0 nuevos.
- Un run nuevo SIEMPRE: `git status` limpio al empezar y al terminar; `tsc root`
  (pnpm build) verde; commit solo de los archivos de la lane.

## 5. Review worktree isolation (A4-2)

> Aislamiento de la verificación de REVIEW en worktree desechable (adoptado por
> el head; fuente: obs. QD q-i-16/q-i-17 — analyze de reviewer-19/reviewer-20
> de la wave R9, 2026-09-05). Un worktree de review NO hermético produce fails
> ESPURIOS (riesgo de falsos veredictos en reviews): la receta (a) lo hace
> hermético; la pauta (b) decide CUÁNDO un worktree hace falta.

### (a) Receta hermética (worktree desechable en scoped-root)

1. **Ruta DENTRO del scoped-root** — p. ej. `/home/esuarez/projects/rX-review-wt`:
   NUNCA `/tmp` (dept_exec DENIED absoluta por diseño — fb-125/builder-8 y
   `git worktree add /tmp/r9-review` real denegado en reviewer-19; desviarse a
   una raíz permitida, R9 review report:133-137).
2. **node_modules LOCAL** (NO symlink al de main): el symlink inyecta el Loader
   del `.pnpm` de MAIN → los packages `dshd-*` resuelven desde MAIN en vez del
   worktree (`ERR_PNPM_UNSAFE_MODULES_DIR`, `tsc` not-found, fail de identidad
   de path E2) → 1 fail espurio E2 + 11 fails de cliente en la 1ª corrida R9
   (825/23/22; analyze reviewer-19:39/:58).
3. **Links ABSOLUTOS a los paquetes espejo del worktree + copia LOCAL del
   cordis-plugin-loader** cuando el Loader lo resuelve (el loader real vive en
   `.pnpm` de main; con node_modules local el worktree necesita la suya).
4. **build:client mirror** para los tests de cliente: `client/client.js` es
   artefacto generado gitignored que el worktree fresco NO tiene → tests de
   cliente ENOENT sin replicar el mirror.
5. **Verificación TARGETED primero** (archivos clave + regresión del área) y
   **suite completa SOLO con el aislamiento confirmado** — los fails espurios
   de montaje NO son regresiones (re-verificar en el árbol main, R9 report
   :103-113).
6. **Cierre**: `git worktree remove --force` (+ `git worktree prune`) y
   `git status` 0 de main (HEAD sin mover, sin push).

**Evidencia del coste (R9):** 1ª corrida 825/23/22 con fails espurios →
corregido 836/12/22 EXACTA (12 canónicos por nombre, §4); reviewer-19 ~24 min
(saga de aislamiento ~14.5 min) vs reviewer-20 ~8.25 min (receta ya en el
brief).

### (b) Condicional (q-i-17 / A4-1) — worktree SOLO si hace falta

Worktree aislado SOLO cuando el commit toca **código de runtime que el Loader
deba resolver** (o se necesite la suite completa del commit). Para commits
**docs/tests puros (0-source)**: verificación **in-place + targeted en el
árbol** (si el test es hermético) — reviewer-20 revisó el fold-in 0-source
6f1175a en 8.25 min SIN worktree (targeted in-tree + delimitación del WIP
ajeno), vs 24.0 min de reviewer-19; ~3x más eficiente, 0 falsos negativos. El
brief de review debe llevar la receta como FALLBACK disponible, no como default
(A4-1, analyze reviewer-20:60).

Fuentes: `.dsh/reports/quality/2026-09-05-worker-retired-reviewer-19-analyze.md`
y `-reviewer-20-analyze.md`;
`/root/.deepartments/departments/internal-programming/reports/reviewer/2026-09-05-r9-spawn-toolset-slug-review-81465423.md`
(método, :103-113 / :133-137).

## 6. Convención de proceso — rutas ABSOLUTAS de reports en briefs (fb-140)

La ruta de reports canónica de un departamento es ABSOLUTA y vive FUERA del
repo (writes vivos en el workspace del depto):
`/root/.deepartments/departments/<dept>/reports/<rol>/<YYYY-MM-DD>-<slug>.md`.

**Regla (fb-140, adoptada por el head):** la convención rige AMBAS
DIRECCIONES — leer y escribir. Los briefs y cualquier cita de reports usan
SIEMPRE la ruta absoluta — NUNCA un short-path tipo `reports/researcher/…`
(al leer desde la base del repo no resuelve: caso 09-04 m-1274
«reports/researcher/2026-09-04-fb134-store-separation.md» → not-found; la ruta
real era
`/root/.deepartments/departments/research/reports/researcher/…`). Y lo que el
worker ESCRIBE — reports, referencias, citas del review — lleva IGUAL la ruta
absoluta del workspace del depto (ronda 09-05: reviewers citando short-paths
en outputs → H4/q-i-47). El workspace del depto y su reports dir YA se
documentan en `docs/departments/internal-programming/README.md` (y specs
004/005/007 §D-Q1); fb-140 complementa a fb-136 (no derivar paths desde
`/.deepartments`).

## 7. Commit-hold procedure (HOLD-P0, lock/mark-red)

Procedimiento de HOLD de commit por lock ROJO, formalizado tras la primera
ejecución real (2026-09-05, ronda wave 4) — validado con disciplina EJEMPLAR
por el análisis QD q-i-43 (`.dsh/reports/quality/2026-09-05-worker-retired-
builder-106-analyze.md`, O1) y completado por los reports builder-106 c551e2b8 /
builder-107 b48b3e05 / builder-108 ce5e1979.

**Cuándo se aplica (HOLD-P0):** cuando el LOCK del árbol está ROJO /
**MAIN-RED** (p. ej. el freeze CUT4 `tools-factory.test.js`) o el floor ordena
hold de commit sobre el árbol compartido. Mientras el lock esté rojo **NO se
commitea NADA encima** — ni la lane propia ni otra; la orden del floor
prevalece sobre el avance local.

**Mecánica (retract semántico, 0 pérdida de trabajo):**

1. Si el commit ya se creó (caso `49910bc`), RETRACTAR con
   `git reset --mixed HEAD~1` — NUNCA `--hard` (pierde los diffs) ni `--soft`
   (los devuelve a staging en vez de unstaged): HEAD vuelve al padre y los
   archivos quedan como diffs ` M` sin commitear, byte-idénticos al commit
   retractado.
2. **Checklist de 4 pasos** tras el retract:
   - **HEAD esperado**: `git rev-parse HEAD` = el commit padre acordado
     (caso real: `49910bc` → `af4757c` = W-3).
   - **Archivos ` M`**: `git status --porcelain` = SOLO los archivos de la lane
     (5 en el caso real), diffs íntegros (10+/9- idénticos).
   - **`git diff --check`** limpio (sin whitespace/EOF).
   - **0 push**: ningún `git push` (el remoto queda intacto; en el caso real
     main quedó `ahead 7` pre-existente, sin push).
3. **Esperar la señal de lock VERDE**: el re-freeze (o la corrección) aterriza
   PRIMERO; no re-committear por iniciativa propia.
4. **Re-commit del contenido pre-revisado**: mismo alcance + mismo mensaje,
   byte-idéntico al commit retractado (`git diff 49910bc 9fd0d47` = vacío,
   builder-108) → reviewer breve; la review del contenido puede hacerse
   in-place sobre los diffs ` M` (condicional §5(b) de A4-2, docs/tests puros).

**Lecciones de la ronda (2026-09-05):**

- **El HOLD DEBE enviarse con `interrupt:true`** para preemptar a un worker EN
  VUELO — el caso builder-106/49910bc: el worker commiteó `49910bc` en el turno
  1 ANTES de recibir el HOLD (m-1629, turno 2) y hubo que retractar después; con
  `interrupt:true` el HOLD aborta el turno en curso y el commit nunca aterriza
  (evita el ciclo commit→retract y la incoherencia de lanzar un reviewer sobre
  el commit ya retractado — G2 del análisis QD).
- **El retiro de un worker es OK SOLO tras la recepción del commit final** — el
  retiro de builder-106 con el WIP ` M` aún sin commitear dejó la lane de commit
  sin ejecutor (G1 del análisis QD; requirió un executor nuevo, builder-108):
  no retirar hasta confirmar que el commit final de la lane aterrizó en el
  árbol.

Referencias: §5 A4-2 (aislamiento de review en worktree + condicional para
docs/tests puros) y §6 fb-140 (citas de reports con ruta absoluta).

## 8. Glob verification rule + SOP «glob = señal, read = prueba» (fb-51/52)

> Fail-loud rule (familia fb-51): un 0 de glob INESPERADO NUNCA concluye «no
> existe» por sí solo — es una SEÑAL de verificar, no una prueba de ausencia.

La herramienta `glob` puede devolver un resultado vacío/«No files found»
SILENCIOSO con ciertos patrones aunque los archivos existan (familia fb-49:
`**`/niveles medios; fb-52: segmento literal inicial con `path` presente, p.ej.
`dshd-orchestration/**` o `src/*.ts` — mientras los `**`-leading o
basename-only encuentran). Estado del matcher (verificado 2026-09-06, lane
fb-52): el RUNTIME servido ya lleva el fix raíz del matcher —
`anchorGlobPattern` en `@deepseek-ai/dsh-tool-fs-search` (sha256 fijado
`02e62ca4…`/`d3940b54…`, exact-argv `--glob=**/dshd-orchestration/**` +
2 reproducciones rg reales PASS) — y el árbol deepartments NO contiene código
glob (external package, greps 0/5 chunks; port upstream → WORK-REGISTER §3).
Con el matcher sano, el guard pendiente es PROCESO, no código:

- **SOP «glob = señal, read = prueba»**: un glob vacío es señal, no prueba —
  ante un 0 INESPERADO verificar SIEMPRE por vías múltiples antes de concluir
  ausencia: (1) `read` directo del archivo/segmento esperado, (2) patrón
  alternativo (`**`-leading, basename-only, o el segmento padre), y (3)
  `dept_exec ls` como último recurso. Solo con ≥2 vías concordantes se concluye
  «no existe».
- **Regla fail-loud (fb-51)**: un 0 inesperado NO debe descartar el check real
  (caso fb-49: checkpoint REAL diagnosticado FICTICIO por falsa negativa —
  split+parada innecesarios). Toda verificación cita la vía usada (glob +
  confirmación `read` directo).
- **No confundir (registral)**: el «fb-52 guard aritmética» del batch 5ada8ac
  es el guard de fragmento aritmético de `dept_exec` (numeración QH fb-53) —
  OTRO guard, ya cerrado en 5ada8ac; el presente §8 es el cierre del record
  fb-52 glob (matcher literal-first-segment), que quedó `abierto` en el backlog
  hasta esta lane.

## 9. ROOT-BUILD GATE — «los prebuilt NO deben enmascarar» (fb-248 class, FB-266, 2026-09-08)

El `pnpm build` de RAÍZ compila SOLO `src/` (tsconfig raíz `"include": ["src"]`):
los tipos de los paquetes del workspace llegan al tsc raíz vía sus
`lib/*.d.ts` PREBUILT (campo `types` del package.json). Un lib STALE (compilado
de un src ANTERIOR) ENMASCARA los errores de tipos reales del build raíz: el tsc
raíz type-checks contra la interfaz vieja, y la primera vez que los paquetes se
recompilan desde su src actual el build raíz explota — la clase fb-266 (b814101
cambió `delivery.ts:334` a `followup(message: UserMessage)` pero las libs stale
ocultaron los 4 sitios sin espejar hasta el recompile completo).

**Gate canónico (anti-masking):** `pnpm build:root-check` =
`node scripts/check-root-build.mjs` — regenera TODO lib de paquete stale (y
SIEMPRE el de dshd-orchestration, el acoplamiento caliente) desde su src, y
LUEGO corre el tsc raíz; falla loud si cualquier paso es != 0. Una lane que
toque src de paquetes O el wiring del build raíz corre ESTE comando EN LUGAR
del `pnpm build` pelado (el build pelado solo es válido cuando las libs ya son
frescas — el gate es la forma verificada). Sitios de invocación:
`package.json "build:root-check"` + el script `scripts/check-root-build.mjs`;
los reviewers del flujo IPD lo usan en la verificación de lanes que tocan
acoplamiento src↔paquete.

### 9.1 El gate PASA A SER el paso 1 — el artefacto no viaja en el commit (fb-2673 → fb-2230, fb-1855; 2026-09-23)

**HECHO MEDIDO.** Con la escalera **COMPLETA Y VERDE** (`pnpm build` exit 0 ·
`plugin add` exit 0 · `dump-config` exit 0 · canary PASS · test 6/6) el **PRIMER
restart cargó código PRE-FIX**: `packages/dshd-core/lib/messages.js` seguía con
mtime 11:57 y **0 ocurrencias** del símbolo. Tras `pnpm build:root-check`
(«regenerated "dshd-core" lib from src (was stale)») el **SEGUNDO restart SÍ**
cargó el fix.

**CAUSA ESTRUCTURAL.** `lib/` está en **`.gitignore:7`** ⇒ **EL ARTEFACTO NO
VIAJA EN EL COMMIT** ⇒ la máquina que **ARRANCA** debe regenerarlo. Y nada lo
garantizaba: **este repo NO tiene CI** (`AGENTS.md:79`: «`deepartments` itself
has NO CI») ⇒ el gate de §9 era una obligación **SOLO-DOC**, sin ejecutor. Un
paso documentado que hay que recordar es, por construcción, un paso que se puede
omitir — ya se omitió una vez.

**EL ARREGLO (dos mitades, y las dos son obligatorias).**

1. **El gate ES el paso 1 de la escalera.** `package.json` `"build"` =
   `node scripts/check-root-build.mjs`; el tsc pelado conserva su nombre propio
   en `"build:tsc"`. Así **no existe forma de correr el paso 1 sin el gate**: no
   es un paso extra que alguien deba recordar, es el paso. La escalera
   `pnpm build` → `plugin add` → `dump-config` → smoke queda **intacta en su
   forma** y gana la garantía en el primer eslabón.
2. **El gate DETECTA y REPARA, y el verde lo GANA midiendo.** Antes de nada
   enumera, por cada objetivo (la raíz —`main: lib/index.js`— y cada
   `packages/*/lib` que resuelven los symlinks `node_modules/dshd-*`), **cada
   salida compilada esperada** según el `tsconfig.json` del propio objetivo
   (`include`/`exclude`/`outDir`/`declaration`/`noEmit`); una salida **AUSENTE**
   o **más VIEJA que su `src`** es violación. Repara con
   `pnpm --filter <pkg> run build` en **orden topológico** (dependencias
   primero; alfabético NO es seguro: `dshd-orchestration` depende de
   `dshd-pooler`/`dshd-quality`), corre el tsc raíz, y **solo entonces vuelve a
   medir**: si algo sigue stale, el gate FALLA — nunca imprime un verde que su
   propia medición contradice.

**DETECCIÓN SIN ESCRITURA.** `pnpm build:check` = `--check`: no escribe NADA y
sale **1** con cada fila stale/missing + el comando de arreglo. Es la forma para
un reviewer/CI/pre-deploy: contesta «¿este árbol puede arrancar con el código que
cree que corre?» sin tocar el árbol.

**POR QUÉ ESTA FORMA Y NO OTRA (lo más simple que cierra el agujero).** (a) Un
**hook de `postinstall`/`prepare`** se dispara en cada `pnpm install` (incluidas
las de CI/reviewer), acopla el build a la instalación y no cubre el caso «src
editado DESPUÉS del install» — que es exactamente el hecho medido. (b) Un
**test** de la suite es demasiado tarde y demasiado débil: la suite corre
**después** del deploy en la escalera, y el fallo no era «un test rojo» sino «un
verde sin efecto»; además la suite se puede correr con `--test-name-pattern`, que
convertiría el gate en opcional. (c) **Regenerar siempre TODO** (`pnpm -r build`)
sería correcto pero paga ~11.7 s en cada paso 1 incluso sin cambios; medir por
archivo paga ~0.15 s en el caso fresco y es **igual de ruidoso** en el caso
stale. La forma elegida es la única que (i) está EN el camino que ya se corre,
(ii) mide el artefacto que el runtime realmente resuelve, y (iii) no conoce el
verde silencioso.

**Evidencia en árbol (builder-487, token `b2d2b66d`).** Al aplicar el gate al
árbol vivo éste encontró un caso REAL de la misma clase:
`packages/dshd-core/lib/delivery.js` **476 s más viejo** que
`packages/dshd-core/src/delivery.ts` — invisible para el `pnpm build` pelado.
Test de regresión: `test/stale-lib-gate.test.js` (13 casos, fixture herméticos
`--root <mkdtemp>`), que blinda (a) el wiring y (b) el instrumento, incluida la
clase que la regla agregada «src más nuevo vs lib más viejo» NO puede ver (una
salida ausente entre hermanas frescas).


## 10. Aislamiento de stateDir en SUBPROCESOS embebidos — el mapa de touchpoints del CONFIG del subproceso (fb-278; lección del cierre fb-234, 2026-09-09)

> En una lane de AISLAMIENTO DE STATEDIR que verifica subprocesos embebidos
> (p.ej. el DSH efímero del canary), el mapa de touchpoints NO se limita a las
> filas del config del HOST ni a las lecturas del proceso PADRE: debe incluir
> **«row→stateDir del config del SUBPROCESO (todas las filas: fila propia / org
> default service-first / env / absoluto)»**.

Caso fb-234: la fila `dshd-health` del DSH efímero resolvía su stateDir por el
org default **transitivo** (service-first — heredaba el default de la org en
vez de una fila propia con ruta explícita); la acceptance «0 huellas del
efímero en el stateDir real» no se cerró hasta mapear esa fila (2 iteraciones
de fix no la cerraron antes). Regla: para verificar un aislamiento, enumerar
las filas del config del SUBPROCESO (fila propia / org default service-first /
env / absoluto) y resolver el stateDir EFECTIVO de cada una — el stateDir
heredado por default es tan touchpoint como una ruta explícita.

## 11. Absence evidence — a `grep` negative over a `.gitignore` tree is INVALID by default (fb-765, 2026-09-11)

> **THE RULE.** `grep` **without an explicit target path** is a WALK of the tree,
> and that walk honours `.gitignore`. The tool's argv is `--json
> --regexp=<pattern>` plus an optional `--glob=<include>` and an optional
> `-- <path>` — it passes **neither `--no-ignore`, nor `--hidden`, nor the VCS
> excludes** that its sibling `glob` uses (`--files … --no-ignore --hidden …`).
> So a 0 from a whole-tree `grep` means *"matched nothing it was willing to look
> at"* — **never** *"does not exist"*. **No absence may be concluded from it.**
> And this repo ignores `lib/` (`.gitignore:7`), `.dsh/reports/` (`.gitignore:2`),
> `client/` and `packages/dshd-gui/client/`, so a whole-tree `grep` is blind to
> the compiled build output, to every report under `.dsh/reports/` and to the
> built client bundle.
>
> **LIFETIME — state this whenever the rule is cited.** This step is the
> **IMMEDIATE mitigation**, in force TODAY for every agent. The upstream fix is
> **now a repo patch of our own** (`patches/dsh-tool-fs-search-*.patch`, the
> A-HARNESS fingerprint-gated chain — §11.6), and the day that patch is applied
> **`grep` stops being blind IN THAT INSTALLATION**. The rule does not die with
> the patch: it still covers **other installations/trees** and **`glob`'s own
> blind classes** (R2/R3), which no argv patch touches. Expiry + renewal
> condition: §11.6.

**Why it matters (the class, not the tool).** A slow search is VISIBLE and
self-correcting; **a silent false negative becomes a LIE in a report** ("this
symbol does not exist", "nothing calls this", "the guard is absent") — and the
next lane builds on that lie. This is the fb-729 class (presence mistaken for
effect) with the polarity reversed: absence mistaken for a fact.

### 11.1 The canonical case, with the measured numbers (this repo, 2026-09-11, run token `aaf91de1`)

**(a) The trap — a whole-tree `grep` returns 0.** The string exists, in a file
that `.gitignore` hides:

```text
$ grep pattern="one search costs a complete model turn" path=/home/esuarez/projects/deepartments
No matches found                                   # ← THE TRAP: 0 matches

$ git check-ignore -v .dsh/reports/explore-deep/2026-08-16-dsh-web-tool.md
.gitignore:2:.dsh/reports/	.dsh/reports/explore-deep/2026-08-16-dsh-web-tool.md
```

**(b) The procedure — with the LITERAL path the evidence appears:**

```text
$ grep pattern="one search costs a complete model turn" path=/home/esuarez/projects/deepartments/.dsh/reports/explore-deep/2026-08-16-dsh-web-tool.md
Found 1 match
/home/esuarez/projects/deepartments/.dsh/reports/explore-deep/2026-08-16-dsh-web-tool.md
Line 32: ... with the native web_search_20250305 server tool — one search costs a complete model turn (maxTokens 4096, maxUses 5)."
```

The same asymmetry in CODE shape (`capacityGateStanza`, the compiled form exists
only in the ignored `lib/`): whole-tree `grep` returns **2 matches, both in
`packages/dshd-orchestration/src/delivery.ts`** (`:2460`, `:2585`), **zero in
`lib/`**; with the compiled-only form as the pattern and the literal path as the
target it returns **1 match**, `packages/dshd-orchestration/lib/delivery.js:1842`
(the same line `read` shows with a literal path). Cross-check against the
vendored ripgrep binary itself, which proves the argv class independently of the
tool wrapper:

```text
$ rg --no-config --json --regexp="one search costs a complete model turn" .
0 matches (exit 1)          # default argv = the tool's argv = .gitignore honoured
$ rg --no-config --json --regexp="…" -- .dsh/reports/explore-deep/2026-08-16-dsh-web-tool.md
1 match
$ rg --no-config --json --regexp="…" --no-ignore .
1 match                     # what the sibling `glob` argv class would have seen
```

**(c) What the doctrine requires before any absence claim** — §11.2 below. The
step is MANDATORY; (a)/(b) above are its reproduction, not an anecdote.

### 11.2 The mandatory confirmation procedure (run it BEFORE writing «does not exist»)

1. **R1 — never conclude from the walk.** A whole-tree `grep` (or `rg`) 0 is a
   SEÑAL, not a proof. It is admissible only AFTER the same pattern has been
   tested against the literal path of the place the thing would live, or against
   a `grep`/`read` whose explicit target is that path.
2. **R2 — `glob` is NOT an existence oracle either (fb-415).** `glob` false-
   negatives when the FIRST SEGMENT of the pattern carries a wildcard: pattern
   `*/package.json` over this repo returns **«No files found»** while
   `packages/dshd-core/package.json` exists and `ls -l`/`read` return it.
3. **R3 — `glob` does not see SYMLINKED directories (fb-763).** `glob` on the
   LITERAL path `packages/dshd-orchestration/node_modules/dshd-core/package.json`
   returns **«No files found»**, while `read` of that SAME path returns the file
   content — two tools of one turn contradicting each other about existence.
4. **OPERATIVE RULE: for EXISTENCE use `read` (or `ls`/`dept_exec ls`) with a
   LITERAL path; `glob` is used to DISCOVER, never to decide existence.** If a
   doctrine prescribed `glob` to confirm, it would prescribe an instrument with
   its own silent false negatives — i.e. it would repeat the very defect it
   exists to prevent.

### 11.3 The closing sentence an agent must be able to apply

> **«This symbol/file does not exist» is only assertable if it was checked with
> `read` (or `ls`) on the LITERAL path, or with a `grep` whose explicit target
> was that path — never from a `grep` that walked a tree with a `.gitignore`.**

### 11.4 The useful contrast (and what is NOT claimed)

- `glob` **does** see ignored and hidden files (`--no-ignore --hidden`): over this
  repo `glob` pattern `packages/dshd-orchestration/lib/*.js` returns the
  gitignored compiled files. So the doctrine mandates `read` **not** because
  `glob` is broken here, but because `glob` has its OWN false-negative classes
  (R2/R3 above), and `read` has none for a literal path.
- **Not claimed:** that a `grep` with an explicit path always finds the FILE
  (rg still refuses binary/ignored-by-`--glob` targets). The walk IS
  deterministic — the blindness geometry is STABLE (§11.2), and that is
  measured, not assumed: three archived whole-tree `grep` calls in the lane that
  produced §11.1, and four further control calls, each returned byte-identical
  results across its repeats, with **0 hits under `lib/`** in both groups. The
  ignored-path hit once read as non-determinism came from a DIFFERENT call whose
  target was an ignored file NAMED LITERALLY, its result later fused with the
  whole-tree call's (`fb-780`, closed `descartado`): a PROVENANCE failure of the
  READER, not an instability of the instrument. The rule therefore stands
  unchanged — an instrument whose 0 does not even reproduce run-to-run is not
  evidence of anything — and gains its mirror: **neither is a 0 whose provenance
  was never checked.**
- **Upstream defect (fb-765 / fb-766) — and it is FIXABLE FROM HERE.** The argv
  asymmetry lives in the harness package `@deepseek-ai/dsh-tool-fs-search`
  (`buildGrepCommand` lacks `--no-ignore`/`--hidden`/`GLOB_VCS_EXCLUDES`; its
  sibling `buildGlobCommand` has them). This repo **already patches that exact
  file three times** — `patches/dsh-tool-fs-search-anchor-literal-glob.patch`,
  `patches/dsh-tool-fs-search-path-not-found.patch`,
  `patches/dsh-tool-fs-search-fb51-direct-edit-normalize.patch` — through the
  **A-HARNESS chain of `scripts/reapply-dsh-patches-a-harness.sh`**, a
  **fingerprint-gated re-apply whose declared purpose is to survive `dsh`
  upgrades** (`patches/README.md:3-7`). The same file is a zone of
  `scripts/zone-md5-manifest.json` (id `a-harness-tool-fs-search-index`) under
  **re-freeze discipline in the SAME change that delivers a patch**. So: the
  fix is a repo patch (argv parity with the sibling, not an invented argv) and
  the report goes upstream **with** the patch — a defect of origin, fixed on our
  side AND reported. The "do not touch the vendored file" reasoning applies only
  to an **unversioned hand edit** — exactly what the fingerprint-gated chain
  exists to replace.
- The upstream report text (defect, lines, affected versions, measured effect,
  the D-765 proposal) is copy-paste ready at
  `.dsh/reports/explore-deep/2026-09-11-fb765-fb766-dsh-tool-fs-search-grep-ignore-asymmetry-aaf91de1.md`.
- Provenance: IPD lane fb-765, builder-311, run token `aaf91de1`, 2026-09-11.
  Every figure above was measured in this repo on that date; the two code cases
  were verified with the native `read` tool on the literal path, never with the
  walk being documented.

### 11.5 Blindness table — pick the instrument whose blind class does not contain your question

The rule above is easier to apply as a property of the INSTRUMENTS than as an
exception to memorise. Every discovery instrument we have is blind to a
DIFFERENT class, and none of them is blind to everything:

| Instrument | BLIND to | Still SEES |
|---|---|---|
| `grep` **without an explicit target path** (a WALK) | everything `.gitignore` ignores **and** everything hidden — canonical case: `lib/` (`.gitignore:7`) | tracked, non-ignored files |
| `grep` **with an explicit path** (file or dir named on the command line) | — the named target is searched directly | the target's content, ignored or not |
| `glob` | directories reached through a **SYMLINK** (fb-763) · patterns whose **FIRST SEGMENT carries a wildcard** (fb-415: `*/package.json` ⇒ «No files found») | ignored + hidden files (`--no-ignore --hidden`), VCS metadata dirs excluded |
| `read` / `ls` on a **LITERAL** path | — no known silent false negative for EXISTENCE | the file itself (content / existence) |
| the **deployed artifact** (`lib/`, `client/`, `packages/dshd-gui/client/`) | — | nothing by accident: it is gitignored, so **every NEGATIVE claim about deployed code requires the OWNER's path** (from the build config or a report), never a walk |

**TIE-BREAK RULE — when two instruments contradict each other about EXISTENCE,
`read` wins.** (Measured instance: `glob` «No files found» on the LITERAL
`packages/dshd-orchestration/node_modules/dshd-core/package.json` while `read`
of that same path returns the file — fb-763.)

**Conclusion to carry: no instrument of ours is blind-ZERO.** Each is blind to
one class; the procedure is to ask *which class my question falls in* and pick
the instrument that is not blind there. The default for the question "does X
exist?" is `read` on a literal path.

### 11.6 Doctrine lifetime — expiry date, renewal condition, and what outlives it

A safeguard with an **expiry** and a written **reason** is worth more than an
eternal rule without one: a rule that lapses silently gets OVER-APPLIED by the
successor, and a rule that outlives its reason gets ignored. So:

- **IN FORCE TODAY.** §11.1-§11.5 protect every agent now, including every
  installation where the patch below has not landed. This step is not optional
  while it is in force.
- **EXPIRY (per installation).** The day the fb-765 patch — `grep` adopting the
  sibling's argv — is applied to an installation, a whole-tree `grep` there
  **stops being blind to ignored/hidden paths**, and the primary trap of §11.1(a)
  disappears. Applied state is per-tree and fingerprint-gated; it is checked, not
  assumed: `scripts/reapply-dsh-patches-a-harness.sh --check` (`PASS` = every
  target is at its applied fingerprint).
- **RENEWAL CONDITION (why the expiry is not a one-way door).** The chain is
  fingerprint-gated on the installed tree's md5s: a `dsh` upgrade that rewrites
  the file leaves the patch **PENDING until it is re-applied** (the script
  reports `NOT APPLIED` / `PARTIAL`). In that window the blindness is BACK. An
  upgrade is therefore a renewal event for this rule, not a retirement of it.
- **WHAT OUTLIVES THE PATCH (the rule is not obsolete after it lands):**
  1. **Other trees.** Any installation, checkout, container or CI runner without
     the patch keeps the behaviour — including trees where we are not the ones
     deciding what is applied.
  2. **`glob`'s own blind classes are NOT fixed by any `grep` patch** — fb-415
     (wildcard first segment) and fb-763 (symlinked directories) live in
     `buildGlobCommand`/the matcher, and stay as measured. §11.2 R2/R3 and the
     tie-break rule of §11.5 remain permanently load-bearing.
  3. **The deployed artifact is still gitignored** — the last row of the §11.5
     table is a property of THIS repo, not of the tool, and no upstream fix
     changes it.
- **History of this correction (so the successor does not re-inherit the
  mistake):** the first draft of this section framed the defect as "vendored ⇒
  not ours ⇒ report only". That premise was FALSE and is corrected here: the
  repo's A-HARNESS patch chain exists precisely to carry such fixes across
  upgrades (`patches/README.md:3-7`), and it already carries three patches for
  this same file.

## 12. Guard durability — a fix in the installed tree is DURABLE only when a manifest row names it (fb-854, 2026-09-14, run token `0b1247cb`)

**The question this section answers** (and the one «está en el fichero» does NOT):
after the next `dsh` upgrade / reinstall, does the fix COME BACK?

**Measured case (fb-854 durability lane).** Two files of the installed runtime
carried the fb-251 bare-400 guard — `…/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js`
and `…/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` — applied by
hand on 2026-08-21 (install-mtime backups `*.bak-fb251-1788961604`). Neither was
in `patches/deepartments-maintenance.tsv`, the only manifest the re-apply
mechanism reads. Experiment: a canary mirror of the installed tree at its
PRISTINE bytes (the two guard files restored from their backups, the two
manifest targets reverse-patched), then
`DSH_PATCH_ROOT_PREFIX=<canary> scripts/reapply-deepartments-patches.sh apply`
— the script's own documented test seam (`reapply-deepartments-patches.sh:68`).
Result: the two registered patches came back (`md5` → `e555ad0c…`, `588c82f9…`),
and the two guard files stayed at their pristine bytes (`a68c27ce…`,
`ff16728d…`). **The guard did not survive a reinstall.** After registering the
two rows + patch files, the same experiment on a fresh canary returns all four
`PATCHED`, each `md5` byte-identical to the live file.

**The rule.** A change to the installed tree is durable **only** through the
registered mechanism (a `patches/*.patch` + `patches/deepartments-maintenance.tsv`
row + the script's fingerprint gates). "It is in the file" is evidence of
PRESENCE, never of durability: the next `install`/`deploy`/`plugin add`
replaces those bytes. State a fix's durability by naming the mechanism that
RESTORES it, and prove it by running that mechanism against a reinstall-like
canary — not by reading the file.

**Corollary (both directions).** (a) A hand-edit is not a fix; it is a fix with
an expiry nobody wrote down. (b) The mechanism is REPO code and needs no
restart, but the restored TARGET does (a lib file of the running daemon is read
at boot): `apply` alone leaves the daemon on the old bytes until the service is
restarted — the same pending-state the A-HARNESS chain documents.

## 13. CI GATE — el gate de `main` en los repos CON CI entra en la escalera ANTES DEL PUSH (fb-XXX, 2026-09-16, run token `cigate1`)

> **LA LEY.** En un repo con CI, un commit NO está verificado por la escalera
> local: la escalera (`pnpm build` → `plugin add` → `dump-config` → smoke) es
> **TODA LOCAL** y puede dar por VERDE un commit que rompe el **pipeline
> publicado**. El gate de `main` es un paso de la escalera y se ejecuta **ANTES
> DEL PUSH** — no después.

**El caso medido (2026-09-16, `dsh-smart-restart`).** El host corrió la escalera
completa, todo verde local, y pusheó **dos veces** a un `main` con CI: runs
**#19** (`4e2bf5e`) y **#20** (`643ec6e`), ambas **`failure`** — y son las DOS
únicas rojas de las 20 del repo. El paso roto fue `pnpm test` (paso 7 del job
`build`); `pnpm build` (paso 6) pasó en ambos. **Nadie se enteró durante ~2 h**:
GitHub no avisa, y la escalera no tenía la mitad observable.

### 13.1 Las DOS mitades (un gate sin la segunda es una casilla que se marca sola)

**(a) La forma — cuándo corre.** Todo push a `main` de un repo con
`.github/workflows/` se da por NO verificado hasta que el run del commit
pusheado esté `completed`/`success`. La escalera local sigue siendo necesaria
(es más rápida y localiza mejor), pero ya **no es suficiente**.

**(b) La observabilidad — `cómo` se consulta y qué cuenta como verde.** Ésta es
la mitad que faltaba: **si el resultado de la CI no es OBSERVABLE, el gate no
existe** — es una casilla que se marca sola. El criterio es **el run del commit
PUSHEADO**, no el último run del repo (un run viejo verde tapa la roja nueva).

```bash
# GATE DE CI — listo para copiar. Sólo lectura; NO requiere credenciales
# para un repo PÚBLICO (HTTP 200 verificado sin token). NUNCA poner un token
# en un informe ni en un mensaje (fb-16).
REPO=edusrez/dsh-smart-restart      # <owner>/<repo> CON CI
SHA=$(git rev-parse HEAD)           # SHA COMPLETO — ver la trampa ⚠️ de abajo
curl -fsS "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA&per_page=1" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=(JSON.parse(s).workflow_runs||[])[0];
    if(!r){console.error("NO RUN for this sha — NOT a pass");process.exit(2);}
    console.log("run #"+r.run_number, r.status, r.conclusion||"");
    process.exit(r.status==="completed" && r.conclusion==="success" ? 0 : 1);
  })'
```

**Lectura del exit code (los tres polos, medidos con el gate real):**

| Exit | Significado | Medición (2026-09-16) |
|---|---|---|
| `0` | **VERDE** — el run del SHA pusheado está `completed`/`success` | `35e4c3d` ⇒ run #18 GREEN |
| `1` | **ROJO** — el run existe y terminó distinto de `success` | `643ec6e` ⇒ run #20 `failure` |
| `2` | **NO-RUN** — no hay run para ese SHA *(o sigue `queued`/`in_progress` y expira el plazo)* | SHA falso ⇒ exit 2, **jamás 0** |

**⚠️ UN GATE QUE NO PUEDE PONERSE ROJO CUANDO EL DEFECTO EXISTE NO ES UN GATE.**
Por eso la tabla de arriba **no es decorativa**: `0/1/2` se probaron uno por uno
contra la API real. El polo `2` es el que impide el falso verde más peligroso —
`head_sha` sin runs devuelve `total_count: 0` con **HTTP 200**, un **cero
silencioso** que un `curl` sin comprobación lee como «no hay problema». Un SHA
sin run NUNCA es un pase: es «aún no verificado» (o un repo/push equivocado).

**⚠️ TRAMPA MEDIDA — el SHA tiene que ser COMPLETO.** `head_sha=643ec6e` (7
chars) devuelve `total_count: 0` con HTTP 200 — **cero silencioso**, indistinguible
de «no hay run». `head_sha=643ec6eaf6746b63f4e86f6317f881a10a8572f7` devuelve
`total_count: 1` ⇒ run #20 `failure`. Usa SIEMPRE `git rev-parse HEAD`.

**Credenciales.** Ninguna para un repo público (medido: HTTP 200 sin token). Para
un repo **privado** la misma consulta necesita un `Authorization: Bearer …` con
un token de sólo lectura `actions:read`; ese token **NUNCA** va al informe ni a
un mensaje (fb-16) — se lee del entorno del operador. Un `403` es **NO-RUN
(exit 2)**, jamás un verde: no poder consultar no es un aprobado.

**Si `gh` está disponible** (`gh` NO lo está hoy en este host — medido: no
resuelve), el equivalente es `gh run list --repo "$REPO" --commit "$SHA" --limit 1
--json status,conclusion,databaseId`; hoy el comando de arriba es el que se
verifica, y el `curl`+`node` no añade dependencias nuevas (ambos ya presentes).

### 13.2 Por qué esto es un paso y no un aviso (y el daño que previene)

El defecto que originó esta sección **no era de código**: el repo tenía la suite
correcta y la CI correcta, y el commit era bueno. Lo que falló fue el
**barrido**: `package.json:47` decía `"test": "node --test"` **sin argumentos**,
y el patrón por defecto de Node incluye **todo** lo que vive bajo un directorio
`test/`. `4e2bf5e` añadió `test/proto-runner.mjs` y
`test/red-401-liveness.mjs`, que **no son tests sino RUNNERS que exigen un path
por CLI** (sus cabeceras lo documentan). Medido en el árbol real:

- `test/red-401-liveness.mjs` **FALLA** sin argumento
  (`ERR_MODULE_NOT_FOUND: .../lib/canary.js`) ⇒ **es el rojo de #19/#20**.
- `test/proto-runner.mjs` **pasa** (84/84) pero **DUPLICA los 84 tests de
  canary**, porque su default `process.argv[2] ?? './lib/canary.js'` sí existe:

```text
node --test            # bare: 272 tests / 270 pass / 2 fail   ← +85 (84 duplicados + 1 rojo)
node --test test/*.test.js   # scoped: 187 / 186 / 1 fail
```

**⇒ La lección que se generaliza, y es la razón de que esto sea una SECCIÓN de la
escalera y no un `chore` del repo:** *un fichero AUXILIAR añadido a `test/` es
código no-probado que entra en la suite por descubrimiento implícito*. **Mover
el fichero arregla el caso de hoy y deja la trampa para el siguiente `.mjs`;
ESCOPAR el barrido cierra la CLASE.** El arreglo aplicado (scoped sweep
`test/*.test.js` + exclusión declarada por nombre del artefacto ROJO a propósito
+ **floor `ls`** para que un glob sin coincidencias sea ruidoso en vez de un
`# tests 0` verde) vive en el `package.json` de `dsh-smart-restart`, con su
razón escrita en la clave `"//test"` del propio fichero.

**El floor (fabricado, medido).** `node --test` con un glob que no casa NINGÚN
fichero sale **verde**: `# tests 0` / EXIT=0. Es el mismo cero silencioso de
§13.1(b) trasladado a la suite: un rename o un vaciado del directorio pasaría
inadvertido para siempre. El `ls` previo lo convierte en EXIT=1 (node ni se
ejecuta) — y esa mitad **se probó por separado**, en el repo y en un directorio
de control.

### 13.3 Especificidad del gate — no todo repo lo tiene

El gate se aplica a repos **con CI** (`.github/workflows/` presente y declarando
`push` a `main`). `deepartments` **no tiene CI** (medido: `.github/workflows/`
no existe) ⇒ su escalera local (pasos 1-4 de `AGENTS.md` § TIERED verification)
sigue siendo la autoridad y este §13 no le añade un paso. Declararlo importa: un
gate que se exige donde no puede ponerse rojo es exactamente la casilla vacía
contra la que esta sección previene.

**Cambios en el `package.json` de un repo con CI: el `--frozen-lockfile`.** El
paso 5 de la CI es `pnpm install --frozen-lockfile`, así que un cambio de
`package.json` obliga a comprobar que **ninguna** sección de dependencias
(`dependencies`/`devDependencies`/`peerDependencies`/`packageManager`/`engines`)
cambió — si cambió, el lockfile está desincronizado y la CI falla en el paso 5
ANTES de compilar. Verificación barata y sin red:

```bash
git show HEAD:package.json > /tmp/old.json   # (en el árbol real, la ruta del brief)
node -e 'const a=require("/tmp/old.json"),b=require("./package.json");
  for(const k of ["dependencies","devDependencies","peerDependencies","packageManager","engines"])
    console.log(k, JSON.stringify(a[k])===JSON.stringify(b[k])?"IDENTICAL":"*** CHANGED ***")'
```

**Fuentes:** run token `cigate1`, IPD builder-401, 2026-09-16 — informe
`/home/esuarez/projects/deepartments/.dsh/reports/builder/2026-09-16-cigate1.md`.
Evidencia primaria: API de GitHub sin credenciales (`runs` + `runs/<id>/jobs`),
más los barridos bare/scoped corridos en el árbol real de `dsh-smart-restart`.


