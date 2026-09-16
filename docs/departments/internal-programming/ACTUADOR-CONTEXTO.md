# El actuador del contexto — la pieza que faltaba, y la que NO cabe aquí

**Lane:** `packages/dshd-health/src/index.ts` + `test/` (run token `25953dc6`,
2026-09-16). **Estado:** implementado y verificado por efecto.

## 1. La brecha, en su clase exacta

`scanContextThreshold` **ya nombra la acción**: al último rung publica
`beyondUsableWindow = true` + `contextAction = 'compact-or-rotate'`. El finding
**ya se alerta** al host por el path findings → dedupe → `notifyHost`. Lo que no
existía era **quien la ejecutara**: el token viajaba en la fila de audit y moría
ahí. Es la clase `fb-967` («el instrumento mide X y el texto nombra Y»).

Lo que se añade aquí es **el consumidor**: cuando un finding llega con
`beyondUsableWindow === true`, el tick **actúa**.

## 2. Qué es la acción (declarada antes de implementarla)

> **MARCADOR DURABLE anclado a la SESIÓN VIVA + ESCALADA al MANAGER del post.
> NO es el corte de admisión de nuevos turnos hacia ese post.**

- **Marcador:** `<stateDir>/context-action.json` → `{ [agentId]: mark }`, con
  `sessionId`, `at`, `action`, `phase`, `pct`, `effectiveTokens`,
  `contextWindow`, `escalatedTo?`. Retención 24 h.
- **Escalada:** un frame al **manager** del post flaggeado vía el seam
  `notifyPost` ya existente, con `sourceKey = context-action:<agentId>:<sessionId>`.

### 2.0 ⚠️ LA MÉTRICA ES DISTANCIA A LA MUERTE, Y ESO MUEVE EL UMBRAL

La muerte ocurre cuando **`use + reserva > window`**, NO cuando `use > window`
(`:5452` `effective = projected + reserve`; `:5501`
`beyondUsableWindow = effective > row.contextWindow`). Con la calibración real
(`1048576 − 262144`) el punto de no retorno es **786.432**, no 1.048.576.

⇒ **La fracción `pct = effective / contextWindow` es DISTANCIA A LA MUERTE**, no
«uso del contexto»: `b5` = «quedan ~520k tokens», no «va por la mitad».

### 2.0.1 Y `contextAction` SE PUBLICA **SÓLO EN b10**

`contextAction` aparece **sólo** cuando `beyondUsableWindow === true` (`:5519`),
y `b10` es la primera banda en la que la siguiente petición **ya es imposible**
(b9 es la última que todavía entra; lo dice el comentario del propio fichero
`:5414-5418`).

⇒ **Un consumidor anclado SÓLO en `contextAction` actúa cuando las peticiones ya
están siendo rechazadas** — y entonces no se puede pedir a la sesión que se
compacte. **Medido:** b8 → `contextAction: undefined`; b9 → `undefined`;
b10 → `'compact-or-rotate'`.

### 2.0.2 ⇒ LAS DOS BANDAS, DECLARADAS (la decisión de umbral)

| Tier (`phase`) | Dispara en | Token | Por qué |
|---|---|---|---|
| `advisory` | `pct ≥ 0.9` (b9) **y la petición TODAVÍA entra** | `rotate-before-death` (**token propio de este consumidor**) | Es la ÚLTIMA banda salvable: quedan 104.858 tk ≈ **11 min** a la tasa activa medida (9.183 tk/min) |
| `beyond-usable-window` | `beyondUsableWindow === true` (b10) | `compact-or-rotate` (**el token del instrumento, verbatim**) | Aquí el scan SÍ nombró la acción; el consumidor sólo la ejecuta |

Dos tokens **distintos a propósito**: en b9 el instrumento no nombró nada, y
fabricar un `compact-or-rotate` sería exactamente la clase `fb-967` («el texto
nombra una acción que el instrumento no»). `b8` y por debajo **no actúan** (hay
margen real).

### 2.0.3 ✅ LA ACCIÓN ES INDEPENDIENTE DE LA SESIÓN (respuesta a «¿cómo le entregas la orden si ya no acepta turnos?»)

**No depende de que la sesión acepte un turno nuevo.** Por construcción:

1. el **marcador lo escribe el proceso DAEMON**, no la sesión flaggeada;
2. la **escalada va al MANAGER** — un post **distinto y sano**, nunca a la
   sesión moribunda (y `manager === agentId` ⇒ cero entrega).

**Medido:** con la sesión flaggeada modelada como **muerta** (sin handle vivo,
incapaz de aceptar nada) y su última fila de proyección presente, el acto **sí
ocurre**: marcador escrito + escalada entregada a otro post. ⇒ El problema
«¿cómo le das la orden a una sesión que ya no acepta turnos?» **no aplica** a
esta acción.

⚠️ Pero eso es **la mitad ganada, no la solución entera**: el marcador es la
**entrada** del corte de admisión (§3). Sin ese corte, el acto es un hecho
observable que un tercero debe consumir.

### 2.0.4 Tensión del anclaje (resuelta): **MÉTRICA SÍ, CLAVE NO**

La **fracción** es la métrica correcta (distancia a la muerte); la **clave `bN`**
NO es identidad fiable (`fb-1091`: reinicia por encarnación, el ledger pierde el
medio). El diseño lo respeta: **mide con la fracción** (el umbral `0.9` se compara
contra `pct`, la fracción publicada por el finding) e **identifica por
`sessionId`** (la clave del ledger). El `bN` no se usa ni como umbral ni como
ancla — sólo viaja dentro del `error` congelado del finding, sin tocar.

### 2.1 El anclaje (la trampa medida `fb-1091`, y por qué el diseño es así)

La serie `bN` de `contextThresholdKey(agentId, band)` **NO identifica un evento
global**: reinicia por encarnación, el ledger pierde franjas (0 filas en un
reinicio con filas antes y después), y `contextThresholdKey` es una clave de
**dedupe por (miembro, banda) con histéresis** — útil para NO repetir alertas,
jamás como identidad de evento.

⇒ **La identidad del acto es `(agentId, sessionId)`** — el hecho medido de la
sesión viva. Semántica resultante, toda verificada por efecto en los tests:

| Situación | Acción |
|---|---|
| Finding **sin** `sessionId` (wiring viejo) | **NO actúa** — sin sesión no hay ancla, y un ancla mala es peor que ninguna |
| Re-cruzada en la **misma** sesión | **NO re-actúa** (mismo episodio) |
| **Nueva encarnación** choca el muro | **SÍ re-actúa** — rotar y volver a chocar son DOS hechos |

### 2.2 Anti-auto-alimentación

La escalada va al **manager** y **nunca al post flaggeado**: dirigirse a la
entidad cuyo contexto está agotado añadiría un pendiente nuevo a la entidad ya
rota (la clase del bucle `fb-759`). Un post **sin** manager (un head, o una
entrada legada sin creador) recibe su **marcador** pero **ninguna entrega** — el
monitor nunca inventa un actor.

## 3. Lo que NO cabe en esta lane (declarado, no fingido)

**El corte real de admisión** vive en el path de entrega/materialización:
`packages/dshd-core/src/delivery.ts` (`deliverOrQueue` / `materializePost`) —
**fuera de la lane congelada**. La pieza exacta a añadir allí:

> En `deliverOrQueue` (o en el gate de `materializePost`), antes de materializar
> un turno para un `postId`: leer `<stateDir>/context-action.json` y, si
> `ledger[postId].sessionId` **coincide con la sesión viva** que se va a
> materializar, **diferir** la materialización (encolar el turno) en vez de
> despertar la sesión que ya no puede hacer el request. La comparación
> `sessionId` es lo que evita el falso positivo de un post que YA rotó.

El marcador se diseñó **para ser consumido desde ahí**: es un fichero plano,
clave = `agentId`, y su campo `sessionId` es exactamente el discriminador que ese
gate necesita.

## 4. Observabilidad

| Artefacto | Formato | Qué prueba |
|---|---|---|
| `<stateDir>/context-action.json` | `{ [agentId]: {sessionId, at, action, phase, pct, effectiveTokens, contextWindow, escalatedTo?} }` | El ACTO ocurrió, anclado a la sesión, con su tier |
| Log: `context-action (<phase>) <action> for "<agentId>" — session <id> at <pct>% …` | línea `logger.warn` | El acto es trazable aunque no haya destinatario |
| Frame entregado al manager | `[From deepartments] context-action (<phase>): …` | La escalada nombró la sesión y su consecuencia REAL (b9: «todavía cabe, ~11 min»; b10: «ya no cabe») |
| `sourceKey` de la entrega | `context-action:<agentId>:<sessionId>` | El metadata de entrega no colisiona entre encarnaciones |
| `health-alerts.jsonl` | (pre-existente, sin cambios) | El finding + ALERT del monitor siguen intactos |

### 4.1 Tiers medidos por efecto (`test/oom-actuador-contexto-25953dc6.test.js`)

```
b5  (50%) proj= 283116 eff= 545260  b5  -> no act
b8  (80%) proj= 629146 eff= 891290  b8  -> no act
b9  (90%) proj= 702546 eff= 964690  b9  -> ACT phase=advisory            action=rotate-before-death
b10      proj= 786433 eff=1048577   b10 -> ACT phase=beyond-usable-window action=compact-or-rotate
```

⚠️ **Nota de calibración del scan (no de esta lane):** el tier latch del scan es
**por AGENTE**, no por sesión. Una secuencia de prueba debe **ascender**
monotónicamente para producir findings; una sesión nueva que arranque por debajo
de la banda latcheada por la sesión anterior queda **SILENCIOSA** por la
histéresis fb-50. No lo toqué (fuera de esta lane) — pero condiciona cómo se
prueba y cómo se lee el ledger.
