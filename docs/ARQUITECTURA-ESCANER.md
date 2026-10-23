# Arquitectura del escáner

> Arquitectura: Claude (2026-09-11, a petición de Isaac). Implementa: Codex.
> Issue: #2. Rama: `agent/codex/2-operations-scanner-rebaseline`.
> Alcance funcional: `docs/CONTRATO-ESCANER.md`. Este archivo decide **con qué** se construye.

> Evolución desde 2026-10-08: consultar el [plan de reestructuración](PLAN-REESTRUCTURACION.md) y la [arquitectura objetivo](ARQUITECTURA-OBJETIVO.md). Conservan las decisiones funcionales y calibraciones de este documento; los módulos propuestos no se presumen implementados.

## Decisiones de Isaac (2026-09-11)

| Decisión | Elegido |
| --- | --- |
| Quién implementa | Codex |
| Dónde viven productos y fotos | Cloudflare Workers + D1 + R2 |
| Con qué se fotografía | Teléfono, aplicación web en el navegador |

Cloudflare porque viste.com.mx ya vive ahí: una sola cuenta, un solo `wrangler deploy`, sin servidor que administrar. El teléfono como cámara obliga a que exista backend: la foto tiene que llegar a la Dell donde se revisa y se imprime.

## Forma del sistema

```text
Teléfono (captura)  ─┐
                     ├─►  un Worker  ─►  D1 (productos, config)
Dell (admin, caja)  ─┘        │       └─►  R2 (fotos)
                              └─────────►  API de Claude (análisis de la foto)
```

Un solo Worker sirve los tres HTML estáticos y la API. Sin segundo servicio, sin Durable Objects, sin colas, sin framework de frontend.

## Estructura en el repositorio

```text
app/
  wrangler.jsonc
  src/worker.ts          enrutador + handlers
  src/analisis.ts        llamada a la API de Claude
  src/precio.ts          fórmula de precio, función pura, con prueba
  public/captura.html    teléfono
  public/admin.html      cola de revisión, configuración, etiquetas
  schema.sql             D1
```

HTML y JS planos servidos como assets estáticos, sin paso de build. La captura es una cámara, una cola en IndexedDB y un `fetch`; React aquí es puro andamio. Si el admin crece hasta pedirlo, se agrega después y solo ahí.

El kit social existente no se toca: sigue en la raíz con su validador.

## `wrangler.jsonc`

- `compatibility_date`: `"2026-09-11"` (la fecha en que se crea; se actualiza a propósito, nunca sola).
- `compatibility_flags`: `["nodejs_compat"]`.
- Bindings: `assets` (directorio `public/`), `d1_databases` (`DB`), `r2_buckets` (`FOTOS`).
- `observability` habilitado con `head_sampling_rate`.
- La llave de la API va por `wrangler secret put ANTHROPIC_API_KEY`. **Ninguna credencial en el repositorio**, ni en `wrangler.jsonc`, ni en un `.dev.vars` versionado.
- `Env` se genera con `wrangler types`. No se escribe a mano.

## D1

```sql
create table productos (
  id             text primary key,          -- crypto.randomUUID() del cliente
  codigo         text unique,               -- código de barras real o MK-000123
  nombre         text not null default '',
  categoria      text not null default '',  -- ropa|hogar|electronica|juguetes|otros
  precio_lista   integer not null default 0,-- centavos MXN
  precio         integer not null default 0,-- centavos MXN
  estado_fisico  text not null default 'nuevo',   -- nuevo|danado
  estado_analisis text not null default 'pendiente', -- pendiente|listo|error
  destino        text not null default 'etiqueta',  -- etiqueta|banda_r19..banda_g199
  stock          integer not null default 1,
  sin_inventario integer not null default 0, -- 1 = las bandas, no descuentan
  semana_ingreso text not null,              -- 'S37'
  foto_key       text not null default '',   -- llave en R2
  creado_en      text not null,
  actualizado_en text not null
);

create table config (clave text primary key, valor text not null);
```

**Dinero en centavos, enteros.** Nada de flotantes en precios.

`config` guarda los porcentajes del contrato (`pct_ropa`, `pct_hogar`, …, `pct_danado`, `limite_banda`, `banda_19`…`banda_199`), con los valores confirmados: 50 % por categoría, 60 % para dañado, límite de banda en $200 (ver `docs/PLAN-ETIQUETAS-POR-BANDA.md`). Se editan desde el admin. Ninguno vive en el código.

Las tablas de ventas llegan con el issue #5, en la misma base. No habrá un segundo maestro de existencias.

## R2

Una foto por producto en `fotos/<id>.jpg`, ya reducida a 1024 px por el teléfono. Bucket privado: se sirve por el Worker en `GET /api/foto/:id`, nunca por URL pública. Las fotos del catálogo público, cuando exista, se copian a otro lado; este bucket no se hace público.

## API del Worker

| Ruta | Qué hace |
| --- | --- |
| `POST /api/borradores` | Recibe `id`, `estado_fisico` y la foto. Guarda en R2, inserta la fila como `pendiente`, **responde 201 de inmediato** y lanza el análisis con `ctx.waitUntil()`. |
| `GET /api/borradores` | Cola del admin, filtrable por estado. |
| `PATCH /api/borradores/:id` | Correcciones del admin: nombre, categoría, precios, destino. |
| `POST /api/borradores/:id/analizar` | Reintento manual de un análisis en `error`. |
| `GET /api/foto/:id` | Sirve la foto desde R2. |
| `GET /api/config`, `PUT /api/config` | Porcentajes y límites. |

`POST /api/borradores` es **idempotente por `id`**: el teléfono genera el `id` con `crypto.randomUUID()` antes de subir, así que un reintento tras una red caída no duplica el producto. Ésta es la pieza que hace que la captura sobreviva a la calle.

## Análisis de la foto

Desde el Worker, con `@anthropic-ai/sdk`, salida estructurada (`output_config.format`) contra un esquema JSON: `nombre`, `categoria` (los cinco valores de arriba), `precio_lista_mxn` y `confianza`. El prompt va en español y pide **lo que costaría nuevo en México**, no el MSRP en dólares, y permite responder vacío antes que inventar.

### Qué modelo — se decide con fotos, no con benchmarks

Costo aproximado por foto (≈1.5 k tokens de entrada, ≈300 de salida) y por pallet de mil piezas:

| Modelo | Por foto | Por pallet |
| --- | --- | --- |
| `claude-opus-5` | $0.015 | ~$15 USD |
| `claude-sonnet-5` | $0.006 | ~$6 USD |
| `claude-haiku-4-5` | $0.003 | ~$3 USD |
| `claude-haiku-5-5` | ~$0.0006 | ~$0.60 USD |
| Gemini Flash | ~$0.001 | ~$1 USD |
| GPT económico | ~$0.001 | ~$1 USD |

**El gasto no es el criterio.** Entre el más caro y el más barato hay unos $14 USD por pallet, minutos de sueldo. Lo que sí cuesta es la **tasa de corrección**: cada nombre mal leído o precio absurdo es una edición manual en la cola del admin. Un modelo 10 % peor son cien correcciones por pallet, y eso se come el ahorro entero.

Diferencia técnica real: Gemini puede apoyarse en búsqueda de Google, lo que para "cuánto cuesta esto nuevo en México" es una ventaja sobre un modelo que responde de memoria. Cuesta latencia, y aquí la latencia no importa porque el análisis corre en segundo plano.

Gemini por Vertex (Issue #363): si la instancia tiene el secreto `VERTEX_API_KEY`, `conGemini()`
llama a Agent Platform (`aiplatform.googleapis.com`, modelo fijo `gemini-3.8-flash`) y se cobra al
proyecto de Google Cloud `gen-lang-client-0344365575`, no a la cuota de AI Studio. Sin ese secreto,
la ruta de AI Studio no cambia. Con búsqueda, el log "analisis listo" trae `fuentes`: los dominios
de donde salió el precio. El grounding se cobra por consulta, aparte del modelo: revisar la tarifa
antes de activarlo en producción.

Punto de partida: `claude-haiku-4-5`, decidido con la prueba del paso 3. Desde el 8/10/2026 corre
`claude-haiku-5-5` (Issue #239): mismo prompt y esquema, ~85 % más barato, con `effort: low`.

Un análisis fallido deja la fila en `error` con su foto intacta. Nunca se borra una foto por un fallo de análisis.

## La impresora manda en la etiqueta

> Reemplazada el 2026-09-20: **AIYIN AE240 BT**, térmica, Bluetooth, rollo de **2 × 1 in
> = 50.8 × 25.4 mm**. La Zebra TLP 2844 (57 × 32 mm, USB, controlador ZDesigner) ya no
> se usa para etiquetas.

**No se habla con esta impresora por el diálogo de impresión de Windows.** El
controlador ignora la geometría de página (escala, márgenes, tamaño de papel) sin
importar cómo se configure; varias sesiones se fueron ajustando esos números antes de
confirmar que el controlador nunca iba a respetarlos. La sonda (`/sonda-impresora`,
PR #50) interrogó la unidad en persona y encontró el único canal que funciona: la
AE240 **solo** acepta datos por la característica BLE `0000fff2` del servicio
`0000fff0`, y **solo** entiende **TSPL** (ESC/POS y CPCL no imprimen nada; las otras
cuatro características escribibles del servicio `49535343`, el UART transparente
típico, tampoco). Esa combinación ya está confirmada en hardware real — no volver a
probar otra.

`app/public/etiquetera.js` (PR #52) le manda el trabajo directo por BLE: arma el
comando TSPL (`tsplEtiqueta()`, función pura, probada sin hardware en
`app/src/etiquetera.test.ts`) y lo transmite en trozos de 20 bytes, la cadencia que
funcionó en la sonda. El botón de imprimir pide la impresora en el mismo clic —antes de
cualquier `fetch`, o el navegador ya no da el permiso— e imprime pieza por pieza con el
avance visible. El diálogo de impresión del navegador y el CSS `@page`/`@media print`
ya no se usan para esta etiqueta.

El módulo del código de barras ya no es un cálculo en milímetros de CSS: la impresora
lo dibuja con el comando `BARCODE` de TSPL, controlado por `MODULO` (puntos) en
`etiquetera.js`. Punto de partida `MODULO = 2`; si el lector no engancha, subir a 3.

**Grado en la etiqueta (Issue #453).** Solo MG usa grados; Ropa omite recuadro, letra y palabra también al reimprimir (Isaac, 23/10/2026). La etiqueta de MG imprime la letra del grado (A, B o C, de `estado_fisico`) en un recuadro de 44 × 44 puntos a la altura del precio, en el borde derecho o a la izquierda del precio de lista tachado (comandos `BOX` y `TEXT` fuente "4"); si el grado no es A, su palabra («Danado», «Liquidacion») se agrega al pie cuando cabe. No se movió ningún otro elemento ni el corrimiento o el módulo calibrados. Cambiar el grado de una pieza ya etiquetada la marca como desactualizada (`etiquetaVigente`); las marcas guardadas antes del grado se leen como A. Requiere prueba física en la AE240.

Esto se verifica con el lector leyendo papel, no con una captura de pantalla. Si esta
unidad (u otra) hay que volver a interrogarla, `/sonda-impresora` sigue desplegada.

## Reglas de Workers que Codex debe respetar

- Nada de bloquear la respuesta con el análisis: `ctx.waitUntil()`, y **sin desestructurar `ctx`**.
- Ninguna promesa suelta: todo `await`, `return`, o dentro de `waitUntil`.
- Sin estado de petición en variables de módulo.
- `crypto.randomUUID()`, nunca `Math.random()` para identificadores.
- Errores con `try/catch` y respuesta JSON explícita; nada de `passThroughOnException`.
- Bindings (`env.DB`, `env.FOTOS`), nunca la API REST de Cloudflare desde adentro.
- `wrangler types` antes de escribir los handlers; sin `any` en `Env`.

## Acceso

**Cloudflare Access delante del Worker**, gratis hasta 50 usuarios: el vendedor y el admin entran con su correo, sin una línea de código de autenticación en el repositorio. Los precios y el inventario no quedan abiertos en internet.

> Actualizado 2026-09-26 (Issue #75): Access **autentica** (cuenta de Google) y la app
> **autoriza**. `src/cuentas.ts` verifica la firma del JWT de Access
> (`Cf-Access-Jwt-Assertion`, equipo y `aud` en `wrangler.jsonc`) en cada petición y
> busca el correo en la tabla `usuarios` (roles: dueño, cajero, capturista; varios por
> persona). Cada ruta tiene sus roles en `permiso()`; lo que no está listado es solo del
> dueño. Sin cuenta activa, la persona solo ve `/sin-acceso`, donde pide acceso con una
> justificación; el dueño aprueba o rechaza en `/cuentas` (rol por omisión: cajero).
> `workers_dev` y las URLs de vista previa están apagadas: el Worker solo responde
> detrás de Access. Para probar local: `wrangler dev --var ACCESS_EQUIPO:local --var DEV_USUARIO:<correo>`.

## Sandbox (Issue #83)

`https://sandbox.viste.com.mx`: el mismo código con su propia D1 (`el-dolaron-sandbox`) y su propio R2 (`el-dolaron-sandbox-fotos`), configurado en `app/wrangler.sandbox.jsonc`. Cada pantalla lleva una franja roja «SANDBOX». Se entra con el mismo login de Access que el escáner (el dominio está agregado a esa aplicación) y con los mismos usuarios y roles.

- **Desplegar:** `npx wrangler deploy --config wrangler.sandbox.jsonc`, desde `app/`. Probar ahí primero y luego desplegar producción.
- **Refrescar datos:** `python tools/refrescar_sandbox.py` borra el sandbox y copia desde producción el esquema completo y los datos de catálogo, configuración, familias, usuarios, solicitudes y ventas. **Nunca copia socios ni Dolarones** (datos personales). Producción solo se lee.
- **Migraciones:** una migración nueva se corre primero en el sandbox (`--config wrangler.sandbox.jsonc`), se prueba y después en producción.
- **Qué no tiene:** fotos (R2 no se copia) y llaves de IA, así que el análisis de fotos falla ahí sin gastar. Las altas de socios y los números de socio del sandbox no afectan el regalo de producción.

## Foto → etiqueta de ropa (Issues #273 y #302)

1. En la computadora, abrir `/etiquetas` del **mismo entorno** en Chrome/Edge,
   conectar la AE240-bt y pulsar «Iniciar / retomar impresión automática».
2. En el teléfono, abrir `/captura` del **mismo entorno**. Modo Ropa ofrece
   $300/$200/$150/$120/$100/$80/$50 MXN y las tallas existentes; escoger ambos antes de disparar.
   El precio se conserva entre fotos, no entre recargas. La foto y el precio se
   guardan juntos en IndexedDB antes de subir, también sin red.
3. `POST /api/borradores` acepta `precio_ropa` en centavos en sandbox y producción
   y únicamente para esos cinco importes. Guarda nombre `Ropa`, talla, precio
   final exacto y estado `listo`, sin IA ni precio de lista supuesto. Un reenvío
   por el mismo UUID conserva stock, precio revisado y código.
4. La computadora consulta cada 2 s las capturas desde el inicio de la sesión,
   usando la hora del servidor (`/api/salud`) y `GET /api/borradores?desde=<ISO>`.
   Espera nombre/precio en orden de captura y reutiliza `/api/etiquetas`, TSPL,
   calibración y pausas de la AE240; una etiqueta por unidad en existencia.
5. «Detener» pausa la sesión. Una recarga permite retomarla sin imprimir el
   inventario anterior. «Nueva sesión», estando pausada, deja las anteriores
   para impresión manual; cada sesión admite hasta 2000 fotos.

Antes del envío automático se guarda su UUID en el navegador. Si BLE falla o la
página se cierra a medias, la sesión se pausa: revisar el papel y la foto, imprimir
manualmente esa pieza o marcarla como impresa, y retomar. Un envío completo se
marca con las funciones existentes y desaparece de la cola. Las pestañas del mismo
navegador coordinan el consumidor con Web Locks; las marcas son por navegador,
como antes, así que se usa **una sola computadora/navegador** para esta sesión.
La AE240 no confirma que salió el papel: «Mostrar impresas» / «No salió desde aquí»
sigue siendo la recuperación física. No se ha cambiado ni validado de nuevo su
calibración en hardware real.

El árbol de decisiones por prenda se definirá después. Los cinco precios
confirmados permiten usar el flujo completo sin gastar IA en ropa.

### Corrección desde miniatura (Issue #275)

En `/captura`, tocar una miniatura muestra los cinco precios y Nuevo/Dañado;
«Guardar cambios» conserva el precio elegido sin descuento automático por condición.
Antes de subir, se guarda en IndexedDB junto a la foto. La revisión abierta pausa
esa subida; al cerrar, la cola aplica también la corrección explícita al servidor
para cubrir una respuesta de alta perdida. Después de subir, se lee el precio y
condición actuales desde `GET /api/borradores/:id/revision`; PATCH cambia únicamente
esos campos, sin reponer stock ni cambiar código. API y controles disponibles en sandbox y producción.

«Eliminar captura» requiere dos toques y conexión. DELETE de esa misma ruta deja
el UUID con `estado_analisis = descartado`, stock/precio cero; con código conserva su foto (#439). Retiene el
UUID para que un POST retrasado no la reviva. No aparece en revisión ni etiquetas.
Sin código, el archivo de R2 se borra después de quitar su referencia; análisis y correcciones
no reabren un descarte. El handler comprueba identidad y ventana de 24 h en las
mutaciones; rechaza eliminar piezas con venta o publicación. No hay migración nueva.

La computadora detecta cambios de precio contra su marca de impresión y envía una
etiqueta nueva con el mismo código. Reemplazar la anterior. Una eliminación no puede
retirar papel ya enviado a la impresora: descartar esa etiqueta físicamente. Precio
y condición locales sobreviven sin red; una eliminación fallida conserva la foto
para reintentar con conexión.

## Captura por UPC desde el manifiesto (Issue #365)

Lo que viene en el manifiesto del proveedor no pasa por foto ni análisis: `/escanear` lee el
UPC, el servidor saca nombre (traducido una vez por UPC), categoría y precio de Target de la
tabla `manifiesto`, y `precio_lista = precio_usd × config.tipo_cambio`. Guardar usa el mismo
alta que la captura sin foto: pieza `listo`, `ED-`, a `/etiquetas`. El precio nunca lo manda
el cliente. Cada escaneo es una pieza nueva (subirle stock a una pieza ya impresa no imprime
etiquetas nuevas). La tabla se llena con `tools/importar_manifiesto.py`. Detalle y decisiones:
[PLAN-MANIFIESTO-UPC.md](PLAN-MANIFIESTO-UPC.md).

## Cámara remota: la PC pide la foto y el celular la toma (Issue #444)

Un buzón por persona (`camara_remota`, llave primaria `correo`; PC y celular entran con la misma
cuenta). La PC crea la solicitud (`PUT /api/camara/solicitud`, UUID propio, reintento idempotente) y el
celular en `/camara-remota` sondea cada ~2 s solo con la pestaña visible (se apaga tras 60 min sin
solicitudes; Wake Lock si existe), la toma (`tomar`), sube la foto por el `POST /api/borradores` de
siempre (`solo_foto` sobre una pieza existente, o alta de pieza nueva) y cierra con `lista`. El
servidor **no cree** el `lista`: comprueba que la pieza del propietario tiene foto escrita desde que
se tomó la solicitud. `vencida` se deriva de `vence_en`, sin cron. `PUT` solo existe en el host de
la PC; `captura.viste.com.mx` solo ve `GET`, `tomar`, `lista` y `cancelar`. `solo_foto` sobre una
pieza inexistente crearía otra, por eso `PUT` y `tomar` verifican que la pieza exista y no esté
descartada.

Excepciones aceptadas por Isaac (22/10): la foto remota vive solo en memoria del celular y no pasa
por `cola-fotos.js` (la cola reprocesaría toda foto como pieza nueva); y repetir sobrescribe la
foto como «Retomar foto». Requiere red y hardware real (prueba física pendiente).

## Orden de entrega

1. Esqueleto: Worker desplegado, D1 creada, R2 creado, `GET /api/config` respondiendo. Probar el despliegue antes de escribir funcionalidad.
2. Captura en el teléfono: cámara continua, cola en IndexedDB, subida con reintento.
3. Análisis con `waitUntil` y la fila pasando de `pendiente` a `listo`. Incluye la prueba comparativa de modelos descrita abajo.
4. Cola del admin: revisión, edición, cálculo de precio y asignación a bin.
5. Etiquetas por lote con Code128 y la semana de ingreso.

Cada paso se prueba desplegado, con teléfono real, antes de pasar al siguiente.

## Prueba comparativa de modelos (parte del paso 3)

Se decide con las fotos de El Dolarón, no con benchmarks ajenos: mercancía americana de liquidación, fotografiada con teléfono, con luz de bodega, y con el precio en pesos como respuesta.

1. Fotografiar **20 piezas reales** variadas: ropa, hogar, electrónica, algo con caja y algo sin marca.
2. Correr las mismas 20 fotos por **`claude-haiku-4-5`** y por **Gemini Flash**, con el mismo prompt y el mismo esquema JSON.
3. Contar, por modelo, cuántas fichas habría que corregir a mano: nombre equivocado, categoría equivocada, o `precio_lista` que no se parece al precio real en México. Una corrección es una ficha, no un campo.
4. Anotar los dos conteos en el Issue #2, con las 20 fotos disponibles para repetir la prueba.

La prueba cuesta centavos. Gana el de menos correcciones; si empatan, gana el más barato. Solo si ambos dejan demasiada limpieza se sube a `claude-sonnet-5` y luego a `claude-opus-5`, repitiendo el conteo.

El modelo vive detrás de una sola función en `app/src/analisis.ts`, con el identificador en una constante. Cambiarlo es un archivo. **No se construye una capa de proveedores**: durante la prueba conviven dos implementaciones, y al terminar se borra la perdedora.

Repetir la prueba cuando cambie el proveedor de modelo o cuando la cola del admin empiece a pedir demasiada corrección.

## Fuera de alcance

Durable Objects, colas, framework de frontend, Vite, autenticación propia, catálogo público, integración de pagos, y cualquier cosa que guarde una segunda cantidad de existencias.
