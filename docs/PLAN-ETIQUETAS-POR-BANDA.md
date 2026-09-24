# Plan: etiquetas por banda de precio

**Estado:** implementado 2026-09-24. Escrito 2026-09-22.
**Relacionado:** Issue #2 (operación del escáner), PR #52 (impresión directa por BLE).

> **Dos decisiones de Isaac (2026-09-23) cambiaron el diseño original de abajo:**
> el camino de "banda" **no** se salta la cámara ni el análisis — toda pieza se
> fotografía y pasa por la IA como hoy, y es el precio que resulta el que decide
> automáticamente banda vs. etiqueta propia, sin juicio de piso. Y la banda más
> alta ($249) se elimina: quedan **siete** precios, no ocho, porque nada llega
> ahí con el nuevo límite de $200. El resto de este documento — el porqué de los
> códigos cortos, el formato TSPL, la estructura de datos — sigue vigente tal
> cual; donde cambia el número, se anota en línea.

## El cambio

Hoy cada pieza cuesta un ciclo completo: foto → análisis → precio → etiqueta con código
único. Eso se justifica para una pieza de $500. No se justifica para una de $19, y la
mayoría de la mercancía es de $19.

Toda pieza se sigue fotografiando y analizando por IA, sin excepción — Isaac lo pidió así:
sin eso no hay precio, y sin precio no hay con qué decidir nada. Lo que cambia es lo que
pasa **después** del precio: **la mayoría de la mercancía deja de tener etiqueta propia.**
Si el precio calculado es de $200 o menos, la pieza se enruta sola a la banda que la
cubre; nadie decide nada en el pasillo. Solo lo que vale más de $200 sigue el camino
completo de hoy.

## Dos caminos

Los dos arrancan igual: foto, análisis, precio. Ahí se bifurcan según ese precio (§5 de
`docs/CONTRATO-ESCANER.md`):

**Banda (el grueso, ≤ $200).** Siete precios × dos familias. La pieza sí queda en
`productos` con su foto y su análisis — es lo que permite ver qué se procesó y ajustar los
porcentajes con datos reales — pero **nunca lleva etiqueta ni código propios**: comparte el
código impreso por lote de su banda (p.ej. `G49`), que ya está pegado en el compartimento
antes de que la pieza llegue. Cero impresión por pieza.

**Joya (la excepción, > $200).** Camino actual sin un solo cambio: captura, análisis,
precio propio, código `ED-XXXXXX`, existencias reales, etiqueta individual impresa por
lote desde `/etiquetas`.

El ahorro no es "menos análisis" — el análisis es el mismo para todas. El ahorro es que el
95 % de las piezas nunca generan un trabajo de impresión propio ni un código que administrar.

## Lo que ya existía y no hubo que construir de cero

Los botes ($20/$40/$60) ya eran exactamente este patrón. Se extendió de 3 a 14, no se
construyó desde cero:

| Pieza | Dónde | Estado |
| --- | --- | --- |
| Filas de precio fijo | `productos` con `sin_inventario = 1` | listo |
| La venta no descuenta existencias | `where id = ? and sin_inventario = 0` (worker.ts) | listo |
| Botones de precio en la caja | rejilla de 14 en caja.html, misma `agregarCodigo()` | listo |
| Escanear un código de banda | `buscarPieza()` hace match exacto de catálogo | listo, sin cambios |
| No ensucian la cola de etiquetas | `/api/borradores` filtra `sin_inventario = 0` | listo |
| Venta por código en reportes | «top productos» agrupa por `codigo` | listo |
| Tarjeta laminada de respaldo | `tarjeta-bandas.html` (antes `tarjeta-bins.html`) | listo |

## Los datos: 14 filas permanentes

Migración `migracion-008-bandas.sql`, con el mismo molde que los botes en
`migracion-003-ventas.sql` (que además elimina, junto con su config):

| Código | Nombre | Precio | Familia |
| --- | --- | --- | --- |
| `R19` … `R199` | Ropa $19 … Ropa $199 | 1900 … 19900 | ropa |
| `G19` … `G199` | General $19 … General $199 | 1900 … 19900 | otros |

Precios en centavos: 1900, 2900, 4900, 7900, 9900, 14900, 19900 (siete, no ocho — se quitó
el $249 al subir el límite de banda a $200: nada llega ahí).

Por fila, igual que un bote: `sin_inventario = 1`, `stock = 0`, `estado_analisis = 'listo'`,
`semana_ingreso = 'S00'`. UUID fijo con formato `00000000-0000-4000-8000-F0000000PPPP`,
donde `F` es 1 para ropa y 2 para general, y `PPPP` el precio en pesos a cuatro dígitos
(`100000000019` = R19, `200000000199` = G199).

`destino` **no** es un valor genérico `'banda'` compartido: cada una de las 14 filas tiene
su propio destino (`banda_r19` … `banda_g199`, en `precio.ts`), igual que `bin_20`/`bin_40`/
`bin_60` antes. Así el admin puede reasignar una pieza a una banda específica y el precio
que vende sale de la configuración de esa banda, no de lo que se haya tecleado — la misma
garantía que ya existía para los botes (`ajustarManual`).

## El código de barras: por qué los códigos son cortos

**Restricción verificada, no estimada.** A módulo 4 puntos (0.5 mm, el ancho confirmado con
el lector el 2026-09-22), un código de barras mide `(11 × (caracteres + 2) + 13) × 4`
puntos, y la etiqueta tiene 406 de ancho:

| Código | Ancho a módulo 4 | ¿Cabe en 406? |
| --- | --- | --- |
| `ROPA-199` | 492 pts | **no, se sale 86** |
| `ROPA-49` | 448 pts | **no, se sale 42** |
| `R199` | 316 pts | sí |
| `R49` | 272 pts | sí |

Por eso `R49`/`G49` y no `ROPA-49`. La alternativa sería bajar el módulo a 3, pero eso
cambia un parámetro que ya está confirmado en hardware, a cambio de nada: la etiqueta ya
dice «ROPA» en texto, el código no necesita explicarse solo.

**No usar códigos puramente numéricos.** `buscarPieza()` manda todo lo que sea `/^\d+$/` a
`ED-` + `padStart(6,'0')`, así que un código de banda numérico chocaría con las piezas
individuales. La letra al frente es lo que los mantiene separados.

## La etiqueta de banda

Sin nombre de producto, el precio se lleva el espacio: de 6 mm hoy a 9 mm.

```
SIZE 50.8 mm,25.4 mm / GAP 2 mm,0 mm / DIRECTION 1 / CLS
TEXT 16,6,"2",0,1,1,"ROPA"                    ; familia, 20 pts
TEXT <centrado>,30,"3",0,3,3,"$49"            ; precio, 72 pts = 9 mm
BARCODE <centrado>,110,"128",48,0,0,4,8,"R49"
TEXT <centrado>,164,"1",0,1,1,"R49 - S38"
PRINT <n>,1
```

Reusa `corrimiento()` y `modulo()` de `etiquetera.js`: misma impresora, misma calibración,
un solo lugar donde vive ese número. Si se quiere el precio aún más grande, la ampliación
4 (96 pts = 12 mm) cabe bajando el código de barras a ~44 pts de alto.

**La semana va impresa.** Con bandas se pierde el historial por pieza, pero la semana da
rebajas por antigüedad sin ningún dato por pieza: «todo lo de S38 o antes, a mitad de
precio». Es la única inteligencia que vale la pena conservar y no cuesta nada.

## Impresión por lote

Pantalla `/bandas`, con la conexión BLE de `etiquetera.js`:

- Cuadrícula de 14 celdas (2 familias × 7 precios).
- Campo de cantidad (por omisión 20).
- Imprimir → `PRINT n,1` de esa banda, en un solo trabajo.

El resultado va a una caja de compartimentos, uno por banda. **Etiquetar deja de depender
de la computadora:** quien etiqueta agarra y pega, y cualquiera puede hacerlo.

## El conteo (diferido, no implementado)

Tabla nueva, append-only:

```sql
create table if not exists tags_impresos (
  id        integer primary key autoincrement,
  codigo    text not null,
  cantidad  integer not null,
  semana    text not null,
  creado_en text not null
);
```

Un renglón por lote impreso, escrito por `POST /api/tags-impresos`. Con eso: impresos por
banda por semana, contra vendidos por banda por semana (que ya sale de «top productos»).

**Advertencia honesta:** esto cuenta *etiquetas impresas*, no *piezas en piso*. Las
etiquetas se desperdician, se pierden y se quedan en la caja sin pegar. Sirve como cota
superior y para ver tendencia; si el número tiene que ser exacto, es un conteo físico.

## La caja

- 14 botones de banda en vez de los 3 de bote (dos renglones de siete, uno por familia).
- Escanear funciona sin tocar nada: `buscarPieza()` ya resuelve match exacto de catálogo.
- `tarjeta-bins.html` se renombró a `tarjeta-bandas.html`, con los 14 códigos.

## Reportes

`porCategoria` en worker.ts mete todo lo de `sin_inventario = 1` en un solo renglón —
ahora `'bandas'` en vez de `'bins'` (nomás el nombre; sigue siendo un solo renglón, no
abierto por banda ni por `p.categoria`). Abrirlo de verdad queda diferido: con 14 bandas
un solo total ya dice poco, pero no bloquea usar el sistema — es dato que se puede sacar
después con las ventas reales acumuladas.

`topProductos` ya agrupa por `codigo`, así que las ventas por banda salen solas sin
tocar nada.

## Lo que NO cambió

- Todo el camino de joyas: captura, análisis, precio, `ED-XXXXXX`, existencias — ahora
  reservado a piezas de más de $200 en vez de "lo que alguien decide que vale la pena".
- La impresión por BLE, la calibración y el relleno del código a 4 dígitos (PR #52).
- La lógica de escaneo de la caja.

## Orden de trabajo

1. `migracion-008-bandas.sql` — 14 filas, quita los 3 botes. **Hecho.**
2. `tsplBanda()` en `etiquetera.js` + pruebas del trabajo TSPL. **Hecho.**
3. Pantalla `/bandas` (impresión por lote). **Hecho.**
4. Tabla `tags_impresos` + endpoint + registro al imprimir. **Diferido** — no bloquea usar
   el sistema, se agrega cuando haga falta medir desperdicio de etiquetas.
5. Botones en la caja + tarjeta laminada. **Hecho.**
6. Abrir `porCategoria` por banda. **Diferido** — solo se renombró el renglón de `'bins'`
   a `'bandas'`; abrirlo por banda individual queda para cuando haya ventas que analizar.

Los pasos 1, 2, 3 y 5 dejan el sistema usable de punta a punta: capturar, que el precio
decida banda o etiqueta, imprimir el lote de la banda, y cobrarla en caja. El conteo y el
reporte abierto por banda (4 y 6) son mejoras posteriores, no bloqueos.

## Decisiones de Isaac (resueltas 2026-09-23)

1. **¿Ocho bandas o menos?** Siete: se quitó $249 al subir el límite a $200 — nada calcula
   ya en ese rango. $19/$29 se quedaron ambas; si en la práctica generan confusión de piso,
   es la primera banda candidata a fusionarse.
2. **¿Qué pasa con $20/$40/$60?** Se eliminan por completo — `migracion-008-bandas.sql`
   borra los tres productos y su config. Un solo sistema, no dos corriendo en paralelo.
3. **El umbral de joya.** $200, y **no** es un juicio de piso: toda pieza se fotografía y
   analiza igual, y es el precio que calcula la IA el que decide sola si la pieza pasa de
   $200 (joya) o no (banda). "Distintiva pero barata" no es un caso especial — si vale la
   pena venderla aparte, el precio que se le ponga ya lo refleja.
4. **¿"General" o algún nombre mejor?** Sin resolver — se usó "General" por default al
   implementar porque nadie propuso alternativa. Es un cambio de una palabra en
   `precio.ts`, `admin.html`, `caja.html`, `bandas.html` y `tarjeta-bandas.html` si Isaac
   quiere otro nombre; no toca la base de datos (la familia interna sigue siendo `g`/`otros`).
