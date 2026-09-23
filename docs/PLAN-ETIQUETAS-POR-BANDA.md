# Plan: etiquetas por banda de precio

**Estado:** propuesta, sin implementar. Escrito 2026-09-22.
**Relacionado:** Issue #2 (operación del escáner), PR #52 (impresión directa por BLE).

## El cambio

Hoy cada pieza cuesta un ciclo completo: foto → análisis → precio → etiqueta con código
único. Eso se justifica para una pieza de $500. No se justifica para una de $19, y la
mayoría de la mercancía es de $19.

La propuesta: **la mayoría de la mercancía deja de tener identidad propia.** Se le asigna
una banda de precio y ya. Solo las piezas que lo valen —las joyas de la corona— siguen el
camino completo de hoy.

## Dos caminos

**Banda (el grueso).** Ocho precios × dos familias. La pieza **nunca entra a `productos`**:
no hay foto, no hay análisis, no hay registro, no hay código único. Alguien la ve, decide
«$49 ropa», le pega una etiqueta ya impresa. Cero trabajo de computadora por pieza.

**Joya de la corona (la excepción).** Pieza de valor alto o distintiva, que una etiqueta
genérica malbarataría. Camino actual sin un solo cambio: captura, análisis, precio propio,
código `ED-XXXXXX`, existencias reales.

La regla para quien etiqueta, en una frase: *¿vale más que la banda más alta, o es lo
bastante distintiva como para que «$249» la deje corta?* → joya. Si no → banda.

Ahí está el ahorro: no en el software, sino en que el 95 % de las piezas dejan de tocar
una computadora.

## Lo que ya existe y no hay que construir

Los botes ($20/$40/$60) ya son exactamente este patrón. Esto es extenderlo de 3 a 16, no
construirlo de cero:

| Pieza | Dónde | Estado |
| --- | --- | --- |
| Filas de precio fijo | `productos` con `sin_inventario = 1` | listo |
| La venta no descuenta existencias | `where id = ? and sin_inventario = 0` (worker.ts) | listo |
| Botones de precio en la caja | `data-codigo="BIN-20"` en caja.html | listo, falta extender |
| Escanear un código de banda | `buscarPieza()` hace match exacto de catálogo | listo, sin cambios |
| No ensucian la cola de etiquetas | `/api/borradores` filtra `sin_inventario = 0` | listo |
| Venta por código en reportes | «top productos» agrupa por `codigo` | listo |
| Tarjeta laminada de respaldo | `tarjeta-bins.html` | listo, falta extender |

## Los datos: 16 filas permanentes

Una migración (`migracion-008-bandas.sql`), con el mismo molde que los botes en
`migracion-003-ventas.sql`:

| Código | Nombre | Precio | Familia |
| --- | --- | --- | --- |
| `R19` … `R249` | Ropa $19 … Ropa $249 | 1900 … 24900 | ropa |
| `G19` … `G249` | General $19 … General $249 | 1900 … 24900 | otros |

Precios en centavos: 1900, 2900, 4900, 7900, 9900, 14900, 19900, 24900.

Por fila, igual que un bote: `sin_inventario = 1`, `stock = 0`, `estado_analisis = 'listo'`,
`destino = 'banda'`, `semana_ingreso = 'S00'`. UUID fijo con formato
`00000000-0000-4000-8000-F0000000PPPP`, donde `F` es 1 para ropa y 2 para general, y `PPPP`
el precio en pesos a cuatro dígitos (`100000000019` = R19, `200000000249` = G249).

`destino = 'banda'` hay que agregarlo al set `DESTINOS` de worker.ts por consistencia,
aunque nada valide estas filas: nunca entran por la API, se siembran una vez.

## El código de barras: por qué los códigos son cortos

**Restricción verificada, no estimada.** A módulo 4 puntos (0.5 mm, el ancho confirmado con
el lector el 2026-09-22), un código de barras mide `(11 × (caracteres + 2) + 13) × 4`
puntos, y la etiqueta tiene 406 de ancho:

| Código | Ancho a módulo 4 | ¿Cabe en 406? |
| --- | --- | --- |
| `ROPA-249` | 492 pts | **no, se sale 86** |
| `ROPA-49` | 448 pts | **no, se sale 42** |
| `R249` | 316 pts | sí |
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

Pantalla nueva `/bandas`, con la conexión BLE de `etiquetera.js`:

- Cuadrícula de 16 celdas (2 familias × 8 precios).
- Campo de cantidad (por omisión 20).
- Imprimir → `PRINT n,1` de esa banda, en un solo trabajo.

El resultado va a una caja de compartimentos, uno por banda. **Etiquetar deja de depender
de la computadora:** quien etiqueta agarra y pega, y cualquiera puede hacerlo.

## El conteo

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

- 16 botones de banda junto a los de bote (dos renglones de ocho).
- Escanear funciona sin tocar nada: `buscarPieza()` ya resuelve match exacto de catálogo.
- Extender `tarjeta-bins.html` a una tarjeta de bandas, laminada, como respaldo.

## Reportes

`porCategoria` en worker.ts mete todo lo de `sin_inventario = 1` en un solo renglón
`'bins'`. Con 16 bandas eso deja de decir nada: hay que abrirlo por banda o por
`p.categoria` (de ahí que las filas lleven `ropa`/`otros`).

`topProductos` ya agrupa por `codigo`, así que las ventas por banda salen solas sin
tocar nada.

## Lo que NO cambia

- Todo el camino de joyas de la corona: captura, análisis, precio, `ED-XXXXXX`, existencias.
- La impresión por BLE, la calibración y el relleno del código a 4 dígitos (PR #52).
- La lógica de escaneo de la caja.

## Orden de trabajo

1. `migracion-008-bandas.sql` — 16 filas. Nada cambia a la vista todavía.
2. `tsplBanda()` en `etiquetera.js` + pruebas del trabajo TSPL.
3. Pantalla `/bandas` (impresión por lote).
4. Tabla `tags_impresos` + endpoint + registro al imprimir.
5. Botones en la caja + tarjeta laminada.
6. Abrir `porCategoria` por banda.

Los pasos 1-3 ya dejan el sistema usable: se puede empezar a etiquetar por banda antes de
que existan el conteo y los reportes.

## Decisiones pendientes de Isaac

1. **¿Ocho bandas o menos?** Cada banda extra es una duda más para quien etiqueta
   («¿esto es $49 o $79?») y un compartimento más en la caja. Cinco o seis es lo usual.
   Los pares que revisaría son $19/$29 y $199/$249.
2. **¿Qué pasa con $20/$40/$60?** Se encima con $19/$29. O se absorben en las bandas, o se
   quedan como botes físicos — pero mantener los dos es tener dos sistemas haciendo un
   trabajo.
3. **El umbral de joya de la corona.** ¿Es sólo «vale más que $249», o también piezas más
   baratas pero distintivas (marca, coleccionable)?
4. **¿«General» o algún nombre mejor?** Es lo que va impreso en la etiqueta.
