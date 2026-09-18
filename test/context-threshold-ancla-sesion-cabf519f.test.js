// ANCLA DE SESIÓN EN LA ALERTA `context-threshold` (builder-432, run token
// cabf519f).
//
// EL DEFECTO MEDIDO: la alerta de umbral se keyea por POST y BANDA, SIN SESIÓN
// (`contextThresholdKey`: `context-threshold:<agentId>:b<band>`), así que NO
// caduca al rotar. Medición del RD (verificada por el host y por la cabeza):
// DOS alertas con MISMA key, MISMA banda (b9), MISMO postId (`research-head`)
// separadas 50 min — `m-16238` (22:32:51, `91% (696459+262144/1048576)`, sesión
// de la PREDECESORA) y `m-16432` (23:22:55, `91% (690137+262144/1048576)`,
// sesión VIVA). El texto era INDISTINGUIBLE salvo por la cifra de tokens: la
// única defensa del receptor era comparar A MANO.
//
// EL ANCLA YA EXISTÍA y no se inventa aquí: el `finding` publica `sessionId`
// (la encarnación que PRODUJO la cifra) y el patrón de render ya estaba probado
// para `post-error` (fb-25 (b) / fb-466). La rama `context-threshold` de
// `buildHealthAlertFrame` simplemente lo IGNORABA.
//
// LO QUE SE PRUEBA AQUÍ, POR EJECUCIÓN:
//   (a) LAS DOS alertas del caso medido son DISTINGUIBLES sin comparar cifras
//       (cada una nombra SU sesión);
//   (a2) la ANTI-CONFUSIÓN: con las cifras CASI IGUALES (696459 vs 690137 — el
//        caso real) las dos viñetas siguen sin poder confundirse, y la sesión
//        nombrada corresponde a la encarnación que produjo CADA cifra;
//   (c) LA GUARDA DE FALSO VERDE: una alerta que DEBE seguir saliendo SIGUE
//       saliendo (no se silenció nada) — la primera Y la segunda encarnación;
//   (b) el literal `error` congelado sigue BYTE-INTACTO (adición = sufijo) y una
//       fila LEGACY sin `sessionId` renderiza byte-idéntica;
//   (d) EL REVERT-CHECK: neutralizar SOLO el ancla pone (a) en ROJO — en un
//       TEMP dir, CERO escrituras dentro del repo.
//
// MÉTODO: la fuente del paquete tiene CERO imports relativos, así que el
// type-stripping nativo de Node carga el CÓDIGO FUENTE ACTUAL directamente —
// sin build, y `packages/dshd-health/lib/` intacto. Cada corrida usa un stateDir
// temporal hermético (el store VIVO y el servicio corriendo NO se tocan).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const H = await import('../packages/dshd-health/src/index.ts')

// El caso MEDIDO, con sus propias cifras y su propia ventana.
const WINDOW = 1_048_576
const RESERVE = 262_144
const POST = 'research-head'
const T0 = new Date(Date.UTC(2026, 8, 17, 22, 32, 51)).getTime() // m-16238 22:32:51Z
const DEAD_TOKENS = 696_459 // m-16238 — la cifra de la sesión MUERTA
const LIVE_TOKENS = 690_137 // m-16432 — la cifra de la sesión VIVA
const DEAD_SESSION = 'sess-predecessor-57bed534'
const LIVE_SESSION = 'sess-live-9f31ac02'
const LOW = 10_000 // ≤ threshold → retorno a normal (resetea el latch)

/** UNA corrida del tick REAL con el sujeto `research-head` en la sesión dada. */
async function tick(stateDir, nowMs, sessionId, projectedTokens) {
  const alerts = []
  await H.runHealthDaemonTick({
    now: () => nowMs,
    stateDir,
    bootId: 'b432',
    hosts: [{ hostId: 'host-asst', sessionId: 'sess-host', roomId: 'board' }],
    sessionContexts: [{ postId: POST, sessionId, contextWindow: WINDOW, projectedTokens }],
    config: { health: { contextCompletionReserve: RESERVE } },
    notifyHost: async (live, frame, key) => alerts.push({ frame, key }),
    logger: { warn: () => {}, info: () => {} }
  })
  return alerts
}

/** La viñeta `context-threshold` de un frame (la línea que lee el host). */
function bulletOf(frame) {
  return frame.split('\n').find((l) => l.startsWith('- context-threshold:'))
}

/** Las DOS alertas del caso medido: la PREDECESORA en b9, un retorno a normal
 * (que resetea el latch), y la encarnación VIVA cruzando la MISMA banda 50 min
 * después — el intervalo REAL medido entre m-16238 y m-16432. */
async function twoIncarnations() {
  const dir = await mkdtemp(path.join(tmpdir(), 'b432-anchor-'))
  try {
    const first = await tick(dir, T0, DEAD_SESSION, DEAD_TOKENS)
    await tick(dir, T0 + 30 * 60_000, DEAD_SESSION, LOW)
    const second = await tick(dir, T0 + 50 * 60_000 + 4_000, LIVE_SESSION, LIVE_TOKENS)
    return { first, second }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// (a) ACEPTACIÓN — las DOS encarnaciones son DISTINGUIBLES sin comparar cifras.
// ---------------------------------------------------------------------------
test('ANCLA (a) ACEPTACIÓN: las dos alertas del caso medido (m-16238 sesión MUERTA / m-16432 sesión VIVA — misma key, misma banda b9, mismo postId) son DISTINGUIBLES sin comparar cifras: cada una nombra SU sesión', async () => {
  const { first, second } = await twoIncarnations()
  assert.equal(first.length, 1, 'la predecesora alerta')
  assert.equal(second.length, 1, 'la encarnación viva alerta (50 min después, retorno a normal por medio)')
  // El DEFECTO, reproducido en la forma exacta: MISMA key, MISMA banda, MISMO post.
  assert.equal(first[0].key, 'context-threshold:research-head:b9', 'la key de la predecesora')
  assert.equal(second[0].key, 'context-threshold:research-head:b9', 'la key de la viva — IDÉNTICA: la key NO distingue encarnación')
  const da = bulletOf(first[0].frame)
  const db = bulletOf(second[0].frame)
  // ⭐ LA ACEPTACIÓN: sin comparar cifras, cada viñeta dice de QUÉ sesión habla.
  assert.match(da, new RegExp(`\\[session ${DEAD_SESSION} `), 'la alerta MUERTA nombra SU sesión')
  assert.match(db, new RegExp(`\\[session ${LIVE_SESSION} `), 'la alerta VIVA nombra SU sesión')
  assert.notEqual(da, db, 'las dos viñetas NO son idénticas (antes lo eran salvo por la cifra)')
  // Y el nombre de la sesión es el que corresponde a la cifra de ESA alerta.
  assert.ok(da.includes('696459'), 'la alerta de la predecesora lleva la cifra de la predecesora')
  assert.ok(db.includes('690137'), 'la alerta viva lleva la cifra de la viva')
})

// ---------------------------------------------------------------------------
// (a2) LA ANTI-CONFUSIÓN, en el caso REAL: las cifras del incidente difieren en
//      <1% (696459 vs 690137) — el lector que hoy compara cifras A MANO tiene
//      que acertar un 0.9%; con el ancla la atribución es ESTRUCTURAL.
// ---------------------------------------------------------------------------
test('ANCLA (a2) ANTI-CONFUSIÓN: con cifras CASI IGUALES (696459 vs 690137, el 0.9% del caso real) el ancla atribuye cada alerta a SU encarnación — la atribución deja de depender del ojo que compara cifras', async () => {
  const { first, second } = await twoIncarnations()
  const da = bulletOf(first[0].frame)
  const db = bulletOf(second[0].frame)
  // Las cifras son tan parecidas que «compararlas a mano» es la defensa frágil.
  const ratio = Math.abs(DEAD_TOKENS - LIVE_TOKENS) / DEAD_TOKENS
  assert.ok(ratio < 0.01, `las cifras difieren un ${(ratio * 100).toFixed(2)}% — indistinguibles a ojo`)
  // La atribución estructural: cruzada — la sesión nombrada VIAJA CON su cifra.
  assert.ok(da.includes('696459') && da.includes(DEAD_SESSION), 'cifra de la muerta ⇔ sesión de la muerta (no cruzadas)')
  assert.ok(db.includes('690137') && db.includes(LIVE_SESSION), 'cifra de la viva ⇔ sesión de la viva (no cruzadas)')
  assert.ok(!da.includes(LIVE_SESSION) && !db.includes(DEAD_SESSION), 'NINGUNA viñeta nombra la sesión de la otra (la confusión es imposible, no improbable)')
})

// ---------------------------------------------------------------------------
// (c) LA GUARDA DE FALSO VERDE — no basta con que la forma nueva informe más:
//     hay que probar que NO SE SILENCIÓ NADA.
// ---------------------------------------------------------------------------
test('ANCLA (c) GUARDA DE FALSO VERDE: las alertas que DEBEN seguir saliendo SIGUEN saliendo — las DOS encarnaciones (la nueva forma no silenció ninguna), y una fila LEGACY sin sesión sigue alertando con la viñeta byte-idéntica', async () => {
  const { first, second } = await twoIncarnations()
  assert.equal(first.length + second.length, 2, 'DOS alertas entregadas (ni una silenciada): la predecesora Y la viva')
  assert.equal(first[0].key, second[0].key, 'y ambas salen por la MISMA key (el dedupe por post+banda sigue INTACTO)')
  // El control LEGACY: una fila SIN sessionId (wiring viejo) alerta igual y su
  // viñeta es byte-idéntica a la de antes del cambio — no se fabrica procedencia.
  const dir = await mkdtemp(path.join(tmpdir(), 'b432-legacy-'))
  try {
    const alerts = await tick(dir, T0, undefined, 520_000)
    assert.equal(alerts.length, 1, 'una fila sin sesión SIGUE alertando')
    // El literal ESPERADO no se escribe a mano (una cifra a mano es una
    // aserción que mide al autor, no al código): se re-deriva del propio scan
    // para la MISMA fila, y la viñeta debe ser exactamente
    // `- context-threshold: <ese error>` — sin ningún `[session …]` añadido.
    const legacyError = H.scanContextThreshold({
      rows: [{ postId: POST, contextWindow: WINDOW, projectedTokens: 520_000 }],
      threshold: H.CONTEXT_THRESHOLD_DEFAULT,
      completionReserve: RESERVE,
      nowMs: T0
    }).findings[0].error
    assert.equal(
      bulletOf(alerts[0].frame),
      `- context-threshold: ${legacyError}`,
      'y su viñeta renderiza BYTE-IDÉNTICA (sin sesión no se inventa ancla)'
    )
    assert.ok(!alerts[0].frame.includes('[session '), 'NINGÚN ancla fabricado para una fila que no publicó sesión')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (b) EL LITERAL CONGELADO — byte-intacto; toda adición va como SUFIJO.
// ---------------------------------------------------------------------------
test('ANCLA (b) EL LITERAL `error` CONGELADO queda BYTE-INTACTO y el ancla va DESPUÉS del aviso de acción (el sufijo de fb-1895 sigue contiguo) — la adición es un sufijo, nunca un reword', () => {
  const finding = {
    kind: 'context-threshold',
    key: 'context-threshold:research-head:b9',
    postId: 'research-head',
    sessionId: LIVE_SESSION,
    ts: T0,
    error: 'research-head 91% (690137+262144/1048576) — cruce b9',
    contextWindow: WINDOW,
    contextProjectedTokens: LIVE_TOKENS,
    contextReserveTokens: RESERVE,
    usableWindowTokens: WINDOW - RESERVE,
    beyondUsableWindow: false
  }
  const frame = H.buildHealthAlertFrame([finding])
  // El literal congelado: la línea EMPIEZA por el `error` íntegro.
  assert.ok(
    bulletOf(frame).startsWith('- context-threshold: research-head 91% (690137+262144/1048576) — cruce b9'),
    'el literal `error` congelado es un PREFIJO byte-intacto de la viñeta (la adición es sufijo)'
  )
  // Auditado además contra el valor literal congelado de la suite.
  assert.equal(finding.error, 'research-head 91% (690137+262144/1048576) — cruce b9', 'el literal `error` de la fila no se toca')
  // El aviso de fb-1895 sigue CONTIGUO al literal (su assert pegada sigue casando)
  // y el ancla se añade DESPUÉS, así que el sufijo de fb-1895 no se rompe.
  assert.match(frame, /— cruce b9 ⇒ ACCIÓN rotate-before-death/, 'el sufijo de acción de fb-1895 sigue contiguo al literal')
  assert.match(frame, /rotate-before-death \(advisory: [^\]]*\) \[session /, 'y el ancla de sesión cierra la viñeta, DESPUÉS del aviso')
})

// ---------------------------------------------------------------------------
// (d) EL REVERT-CHECK — neutralizar SOLO el ancla pone (a) en ROJO. Se hace en
//     un TEMP dir (ZERO escrituras dentro del repo).
// ---------------------------------------------------------------------------
test('ANCLA (d) REVERT-CHECK: neutralizando SOLO el ancla de sesión, la aceptación de (a) se pone en ROJO — demostrado, no afirmado', async () => {
  const srcPath = path.join(import.meta.dirname, '..', 'packages', 'dshd-health', 'src', 'index.ts')
  const source = await readFile(srcPath, 'utf8')
  // LA PUERTA DE ESTA LANE: la interpolación del ancla en la viñeta de
  // `context-threshold`. Debe aparecer EXACTAMENTE una vez (un revert que no
  // casa nada no prueba nada).
  const GATE = '${sessionAnchor}'
  assert.equal(source.split(GATE).length - 1, 1, 'la puerta del ancla se encuentra EXACTAMENTE una vez')
  const reverted = source.replace(GATE, '')

  /** La aceptación (a), como función del módulo bajo prueba: ¿las dos alertas
   * se distinguen SIN comparar cifras? */
  const acceptanceHolds = async (mod) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b432-rev-'))
    try {
      const fire = async (nowMs, sessionId, tokens) => {
        const alerts = []
        await mod.runHealthDaemonTick({
          now: () => nowMs,
          stateDir: dir,
          bootId: 'rv',
          hosts: [{ hostId: 'host-asst', sessionId: 'sess-host', roomId: 'board' }],
          sessionContexts: [{ postId: POST, sessionId, contextWindow: WINDOW, projectedTokens: tokens }],
          config: { health: { contextCompletionReserve: RESERVE } },
          notifyHost: async (live, frame, key) => alerts.push({ frame, key }),
          logger: { warn: () => {}, info: () => {} }
        })
        return alerts
      }
      const a = await fire(T0, DEAD_SESSION, DEAD_TOKENS)
      await fire(T0 + 30 * 60_000, DEAD_SESSION, LOW)
      const b = await fire(T0 + 50 * 60_000 + 4_000, LIVE_SESSION, LIVE_TOKENS)
      assert.equal(a.length + b.length, 2, 'las DOS alertas siguen saliendo (la guarda de falso verde, dentro del revert-check también)')
      const ba = bulletOf(a[0].frame)
      const bb = bulletOf(b[0].frame)
      // LA ACEPTACIÓN: cada viñeta nombra SU sesión.
      assert.match(ba, new RegExp(`\\[session ${DEAD_SESSION} `), 'la alerta muerta nombra su sesión')
      assert.match(bb, new RegExp(`\\[session ${LIVE_SESSION} `), 'la alerta viva nombra su sesión')
      assert.notEqual(ba, bb, 'las dos viñetas no son idénticas')
      return { ba, bb }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const tmpHome = await mkdtemp(path.join(tmpdir(), 'b432-revsrc-'))
  try {
    const revertedPath = path.join(tmpHome, 'reverted-index.ts')
    await writeFile(revertedPath, reverted, 'utf8')
    await symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(tmpHome, 'node_modules'), 'dir')
    const R = await import(new URL(`file://${revertedPath}`).href)

    // En el árbol REVERTIDO la aceptación DEBE fallar…
    await assert.rejects(
      () => acceptanceHolds(R),
      /nombra su sesión/,
      'REVERT PROOF (literal): con el ancla neutralizada la aceptación LANZA — las dos viñetas vuelven a ser indistinguibles salvo por la cifra'
    )
    // …y en el árbol REAL debe pasar (la comprobación es falsable en AMBOS sentidos).
    const live = await acceptanceHolds(H)
    assert.match(live.ba, /\[session /, 'en el árbol real el ancla está presente')
  } finally {
    await rm(tmpHome, { recursive: true, force: true })
  }
})
