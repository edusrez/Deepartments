// builder-440 (token c0e965db) — ★★ LOS DOS EJES QUE LE FALTABAN AL DIGEST DE
// SALUD (eje i duración de la clase que el digest DESCUENTA + eje ii AUSENCIA DE
// LLEGADAS por destinatario). Evidencia citada (NO re-investigada):
// `.dsh/reports/host/2026-09-18-instrumento-prepared-y-cola-real.md` §28 (el
// digest midió 15 pares, los certificó y reportó PASS por la barra ~8 h), §31
// (137 min de corte), §36 (los DOS ejes + «la única vía viva era la llegada»).
//
// PRE/POST (el requisito declarado de la misión): la MISMA prueba corre contra el
// código de ANTES y el de DESPUÉS —
//   PRE :  HEALTH_SRC=<copia del src anterior (git show HEAD:...)> node --test <este fichero>  ⇒ DEBE FALLAR
//   POST:  node --test <este fichero>                                                            ⇒ DEBE PASAR
// La copia PRE vive en un directorio DENTRO del paquete para que la resolución de
// `dshd-core` (node_modules del paquete) siga funcionando; el harness la crea y la
// borra (ver el comando en el reporte de la lane).
//
// QUÉ MIDE ESTA PRUEBA: la DECISIÓN del tick REAL (`runHealthDaemonTick`) sobre un
// stateDir fixture — el hallazgo, la clave de dedupe, la alerta al host, el dato
// del heartbeat y el re-suministro por notifyPost.
// QUÉ **NO** MIDE (declarado): no mide el transporte real (no hay bus ni sesiones:
// `notifyHost`/`notifyPost` son espías), ni la latencia del daemon, ni el ledger
// VIVO de producción (la calibración sobre `/.deepartments/deliveries.jsonl` se
// hizo con los probes del workspace y va en el reporte), ni la compactación del
// sidecar (la prueba usa el fichero tal cual lo escribe el bus).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The module under test: the package's src by default, or the PRE copy via env.
const HEALTH_SRC = process.env.HEALTH_SRC ?? new URL('../src/index.ts', import.meta.url).href
const H = await import(HEALTH_SRC)
const { runHealthDaemonTick, readHealthHeartbeatFile, readHealthAlertsState } = H
// The sidecar path helper comes from dshd-core's src (the wake-seam test's own
// import pattern) — dshd-health consumes it but does not re-export it.
const C = await import(new URL('../../dshd-core/src/messages.ts', import.meta.url).href)
const { resolveDeliveriesPath } = C

// The digest's own read point (2026-09-18T06:19Z, when the system wrote PASS).
const T0 = Date.UTC(2026, 8, 18, 6, 19, 0)
const MIN = 60_000
// The measured facts of the cut (verbatim from §28/§31): last arrival to
// research-head 05:27:14 ⇒ 52 min before the digest; the 15 write-ahead rows
// start 05:30:38 ⇒ ~48 min old at the digest moment.
const CUT_LAST_ARRIVAL_MS = 52 * MIN
const CUT_PAIR_AGE_MS = 48 * MIN

async function withTempStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'starvation-'))
  try {
    return await fn(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function writeDeliveries(stateDir, rows) {
  await writeFile(resolveDeliveriesPath(stateDir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function row(messageId, recipientId, status, ts, noWake) {
  return noWake === true ? { messageId, recipientId, status, ts, noWake } : { messageId, recipientId, status, ts }
}

/** THE 09-18 CUT, reproduced on a fixture: `research-head`'s last ARRIVAL
 * (`delivered`) sits `arrivalAgeMs` in the past, and the 15 sealed-AWAKE pairs it
 * never received (`prepared` + `noWake` — the class the digest discounted, in the
 * direction that is still winnable) are `pairAgeMs` old. */
function cutRows({ arrivalAgeMs = CUT_LAST_ARRIVAL_MS, pairAgeMs = CUT_PAIR_AGE_MS, noWake = true, status = 'prepared', count = 15 } = {}) {
  const rows = [row('m-17000', 'research-head', 'delivered', T0 - arrivalAgeMs)]
  for (let i = 0; i < count; i++) {
    rows.push(row(`m-17079${String(i).padStart(2, '0')}`, 'research-head', status, T0 - pairAgeMs, noWake))
  }
  // A healthy head that keeps receiving (the control that must never escalate).
  rows.push(row('m-18000', 'quality-head', 'delivered', T0 - 2 * MIN))
  return rows
}

const CATALOG = [{ postId: 'research-head' }, { postId: 'quality-head' }]

function tickDeps({ stateDir, nowMs, posts = CATALOG, hosts = [{ hostId: 'host-asst', sessionId: 's-live' }], config = { health: {} }, alerts, wakes, notify = false }) {
  return {
    now: () => nowMs,
    stateDir,
    bootId: 'boot-starvation-1',
    config,
    hosts,
    posts,
    notifyHost: async (hostEntry, frame) => { alerts.push({ hostEntry, frame }) },
    ...(notify ? { notifyPost: async (postId, frame, opts) => { wakes.push({ postId, frame, opts }) } } : {})
  }
}

const bullets = (frame) => (frame.match(/- recipient-starved[^\n]*/g) ?? [])

// ---------------------------------------------------------------------------
// (1) THE DISCRIMINATING MEASURE — the 09-18 cut ESCALATES instead of PASS.
// ---------------------------------------------------------------------------
test('EJE (i)+(ii): el corte del 09-18 (52 min sin llegadas, 15 pares sellados sin entregar de 48 min) YA ESCALA — hallazgo L1 + alerta al host + dato en el heartbeat; ANTES del cambio esta prueba FALLA (0 hallazgos, 0 dato)', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, cutRows())
    const alerts = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts }))
    const frame = alerts.map((a) => a.frame).join('\n')
    assert.equal(alerts.length, 1, 'POST: el tick alerta al host por el pipeline EXISTENTE (un frame agrupado)')
    const lines = bullets(frame)
    assert.equal(lines.length, 1, 'POST: UN hallazgo recipient-starved (por destinatario, no por par)')
    assert.match(lines[0], /recipient-starved.*research-head/, 'POST: el hallazgo nombra al destinatario desabastecido (research-head)')
    assert.match(lines[0], /15 par\(es\) sin entregar/, 'POST: el eje (i) mide la DURACIÓN de la clase descontada — los 15 pares que el digest contó')
    assert.match(lines[0], /52 min SIN NINGUNA LLEGADA/, 'POST: el eje (ii) mide la AUSENCIA de llegadas del destinatario — el dato que no existía')
    // (d) NUNCA se nombra el estado del post como condición (la guarda que NO explicaba el silencio).
    assert.doesNotMatch(frame, /running|idle|dormant/, 'POST: el hallazgo NO razona por estado del post (aceptación (b) y (d))')
    const hb = readHealthHeartbeatFile(stateDir)
    assert.equal(hb.starvation.heldRecipients, 1, 'POST: heartbeat.starvation.heldRecipients = 1 (eje i — hay pares por encima de su barra de duración)')
    assert.equal(hb.starvation.starvedRecipients, 1, 'POST: heartbeat.starvation.starvedRecipients = 1 (AMBOS umbrales cruzados en CÓDIGO)')
    assert.equal(Math.round(hb.starvation.oldestAbsenceMs / MIN), 52, 'POST: el heartbeat publica la AUSENCIA medida (52 min, el número de §28)')
    assert.equal(Math.round(hb.starvation.oldestHeldMs / MIN), 48, 'POST: el heartbeat publica la edad del par más antiguo (48 min)')
    const ledger = readHealthAlertsState(stateDir)
    assert.ok(ledger['recipient-starved:research-head'] !== undefined, 'POST: la clave de dedupe por destinatario avanzó en el ledger COMPARTIDO (≤1 alerta por 30 min)')
    // The PRE run reaches this assertion line with no key at all ⇒ FAILS (the
    // ledger is empty: the tick had no such axis).
    assert.notEqual(ledger['recipient-starved:research-head'], undefined, 'PRE/POST: sin el eje, esta clave NO EXISTE (la prueba FALLA en el código anterior)')
  })
})

// ---------------------------------------------------------------------------
// (2) THE LADDER (the threshold must produce a signal that cannot be ignored).
// ---------------------------------------------------------------------------
test('ESCALERA: el reloj es el de AUSENCIA (60 min → L2 con re-suministro del destinatario, 120 min → L3) y cada tier tiene su clave propia', async () => {
  await withTempStateDir(async (stateDir) => {
    // The fixture is static (no new arrivals): the absence clock grows with nowMs.
    await writeDeliveries(stateDir, cutRows())
    // L1 at T0 (52 min).
    const a1 = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts: a1, notify: true, wakes: [] }))
    assert.equal(readHealthAlertsState(stateDir)['recipient-starved:l2:research-head'], undefined, 'L1: sin tier L2 a los 52 min')
    // L2 at T0+10 min (absence 62 min ≥ 60) — and the recipient is RE-SUPPLIED.
    const a2 = []
    const wakes2 = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0 + 10 * MIN, alerts: a2, notify: true, wakes: wakes2 }))
    assert.equal(readHealthAlertsState(stateDir)['recipient-starved:l2:research-head'] !== undefined, true, 'L2: la clave :l2 existe a los 62 min de ausencia')
    assert.match(a2.map((a) => a.frame).join('\n'), /recipient-starved L2/, 'L2: el frame nombra el tier explícitamente (el digest no puede leerlo como WATCH)')
    assert.equal(wakes2.length, 1, 'L2: UN re-suministro al destinatario desabastecido (el wake ES el suministro)')
    assert.equal(wakes2[0].postId, 'research-head', 'L2: el re-suministro va al destinatario desabastecido, no a un tercero')
    assert.equal(wakes2[0].opts.interrupt, false, 'L2: semántica QUEUE — NUNCA se aborta un turno vivo por un reloj de duración (anti-fb-163/171)')
    assert.equal(wakes2[0].opts.sourceKey, 'recipient-starved:l2:research-head', 'L2: el sourceKey es la clave del tier (trazabilidad del interrupt-state)')
    // L3 at T0+70 min (absence 122 min ≥ 120) — the sustained cut escalates.
    const a3 = []
    const wakes3 = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0 + 70 * MIN, alerts: a3, notify: true, wakes: wakes3 }))
    assert.equal(readHealthAlertsState(stateDir)['recipient-starved:l3:research-head'] !== undefined, true, 'L3: la clave :l3 existe a los 122 min (corte sostenido)')
    assert.match(a3.map((a) => a.frame).join('\n'), /recipient-starved L3/, 'L3: el frame marca el escalado (≥120 min sin llegadas)')
    assert.equal(wakes3.length, 1, 'L3: el re-suministro se reintenta en el tier L3 (clave propia ⇒ cadencia propia)')
  })
})

// ---------------------------------------------------------------------------
// (3) THE NEGATIVE CONTROLS — a healthy system does NOT escalate.
// ---------------------------------------------------------------------------
test('CONTROL NEGATIVO A: los MISMOS 15 pares sellados con llegadas VIVAS (última hace 2 min) NO escalan — el eje (i) mide, el (ii) es el que decide', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, cutRows({ arrivalAgeMs: 2 * MIN }))
    const alerts = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts }))
    assert.equal(bullets(alerts.map((a) => a.frame).join('\n')).length, 0, 'CONTROL A: NINGÚN hallazgo — el destinatario ESTÁ recibiendo (la duración sola no basta)')
    const hb = readHealthHeartbeatFile(stateDir)
    assert.equal(hb.starvation.heldRecipients, 1, 'CONTROL A: el eje (i) SÍ midió los pares retenidos (1 destinatario) — el dato no desaparece, no escala')
    assert.equal(hb.starvation.starvedRecipients, 0, 'CONTROL A: 0 destinatarios cruzando ambos umbrales')
    assert.equal(hb.starvation.oldestAbsenceMs, undefined, 'CONTROL A: sin sujetos no se publica ausencia (ausencia del dato, no un 0 inventado)')
  })
})

test('CONTROL NEGATIVO B (el medido): 547 pares sellados `self` de 16 días en quality-head (sellado POR DISEÑO) y 16 días sin llegadas NO disparan — la dirección CIERRE del censo queda FUERA', async () => {
  await withTempStateDir(async (stateDir) => {
    const rows = [row('m-1', 'quality-head', 'delivered', T0 - 16 * 24 * 60 * MIN)]
    for (let i = 0; i < 547; i++) rows.push(row(`m-20${String(i).padStart(3, '0')}`, 'quality-head', 'self', T0 - 16 * 24 * 60 * MIN, true))
    await writeDeliveries(stateDir, rows)
    const alerts = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, posts: [{ postId: 'quality-head' }], alerts }))
    assert.equal(bullets(alerts.map((a) => a.frame).join('\n')).length, 0, 'CONTROL B: 0 hallazgos sobre el sellado BY-DESIGN (self ⇒ needsRedelivery false) aunque su ausencia sea de 16 días')
    const hb = readHealthHeartbeatFile(stateDir)
    assert.equal(hb.starvation.heldRecipients, 0, 'CONTROL B: 0 retenidos (la dirección DESPIERTA del censo, no el sellado por diseño)')
    assert.equal(hb.starvation.starvedRecipients, 0, 'CONTROL B: 0 desabastecidos')
  })
})

test('CONTROL NEGATIVO C: pares retenidos FRESCOS (< 30 min) con ausencia vieja NO escalan — el término de DURACIÓN tiene su propia barra', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, cutRows({ pairAgeMs: 20 * MIN }))
    const alerts = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts }))
    assert.equal(bullets(alerts.map((a) => a.frame).join('\n')).length, 0, 'CONTROL C: sin DURACIÓN medida no hay hallazgo (los dos umbrales están EN la decisión)')
    assert.equal(readHealthHeartbeatFile(stateDir).starvation.heldRecipients, 0, 'CONTROL C: 0 retenidos por encima de la barra de 30 min')
  })
})

test('CONTROL NEGATIVO D: un destinatario SIN ninguna evidencia de llegada en el ledger no certifica silencio (nunca fabricar ausencia)', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, [row('m-1', 'research-head', 'prepared', T0 - 48 * MIN, true)])
    const alerts = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, posts: [{ postId: 'research-head' }], alerts }))
    assert.equal(bullets(alerts.map((a) => a.frame).join('\n')).length, 0, 'CONTROL D: 0 hallazgos — sin fila de llegada previa la ausencia NO se puede medir (dato ausente ≠ silencio medido)')
    assert.equal(readHealthHeartbeatFile(stateDir).starvation.heldRecipients, 1, 'CONTROL D: el eje (i) sí midió el par retenido (el sujeto existe; el reloj de ausencia no)')
  })
})

// ---------------------------------------------------------------------------
// (4) ACCEPTANCE (d) — the axis is INDEPENDENT of the post's running state.
// ---------------------------------------------------------------------------
test('ACEPTACIÓN (d): el destinatario marcado `running: true` (y `sleeping: true`) TAMBIÉN dispara — el eje no se construye sobre la guarda running; el RD estaba `idle` cuando se le cortó el suministro', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, cutRows())
    const alerts = []
    await runHealthDaemonTick(
      tickDeps({
        stateDir,
        nowMs: T0,
        posts: [{ postId: 'research-head', running: true, sleeping: true }, { postId: 'quality-head' }],
        alerts
      })
    )
    const lines = bullets(alerts.map((a) => a.frame).join('\n'))
    assert.equal(lines.length, 1, 'ACEPTACIÓN (d): el hallazgo aparece con el post `running` (la ausencia de llegadas no depende de su liveness)')
    assert.match(lines[0], /research-head/, 'ACEPTACIÓN (d): y nombra al mismo destinatario')
  })
})

// ---------------------------------------------------------------------------
// (5) THE KNOBS — both thresholds are real code knobs (not prose).
// ---------------------------------------------------------------------------
test('KNOBS: subir cualquiera de las DOS barras apaga la señal — las dos viven en la DECISIÓN (health.starvationHeldMs / health.starvationAbsenceMs)', async () => {
  await withTempStateDir(async (stateDir) => {
    await writeDeliveries(stateDir, cutRows())
    const aHeld = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts: aHeld, config: { health: { starvationHeldMs: 120 * MIN } } }))
    assert.equal(bullets(aHeld.map((a) => a.frame).join('\n')).length, 0, 'KNOB eje (i): con la barra de duración a 120 min los pares de 48 min no cuentan ⇒ sin señal')
    const aAbs = []
    await runHealthDaemonTick(tickDeps({ stateDir, nowMs: T0, alerts: aAbs, config: { health: { starvationAbsenceMs: 120 * MIN } } }))
    assert.equal(bullets(aAbs.map((a) => a.frame).join('\n')).length, 0, 'KNOB eje (ii): con la barra de ausencia a 120 min los 52 min de silencio no cuentan ⇒ sin señal')
    // And the gate turns the axis off entirely (no scan, no heartbeat datum).
    const aOff = []
    const offStateDir = stateDir
    await runHealthDaemonTick(tickDeps({ stateDir: offStateDir, nowMs: T0, alerts: aOff, config: { health: { starvationEnabled: false } } }))
    assert.equal(readHealthHeartbeatFile(offStateDir).starvation, undefined, 'GATE: con la axis apagada el heartbeat NO publica el dato (nunca sintetizado)')
  })
})
