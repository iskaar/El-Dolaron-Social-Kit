# Arquitectura del escáner

> Arquitectura: Claude (2026-09-11, a petición de Isaac). Implementa: Codex.
> Issue: #2. Rama: `agent/codex/2-operations-scanner-rebaseline`.
> Alcance funcional: `docs/CONTRATO-ESCANER.md`. Este archivo decide **con qué** se construye.

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
  destino        text not null default 'etiqueta',  -- etiqueta|bin_20|bin_40|bin_60
  stock          integer not null default 1,
  sin_inventario integer not null default 0, -- 1 = los bins, no descuentan
  semana_ingreso text not null,              -- 'S37'
  foto_key       text not null default '',   -- llave en R2
  creado_en      text not null,
  actualizado_en text not null
);

create table config (clave text primary key, valor text not null);
```

**Dinero en centavos, enteros.** Nada de flotantes en precios.

`config` guarda los porcentajes del contrato (`pct_ropa`, `pct_hogar`, …, `pct_danado`, `limite_bin`), con los valores confirmados: 50 % por categoría, 60 % para dañado, límite de bin en $60. Se editan desde el admin. Ninguno vive en el código.

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
| Gemini Flash | ~$0.001 | ~$1 USD |
| GPT económico | ~$0.001 | ~$1 USD |

**El gasto no es el criterio.** Entre el más caro y el más barato hay unos $14 USD por pallet, minutos de sueldo. Lo que sí cuesta es la **tasa de corrección**: cada nombre mal leído o precio absurdo es una edición manual en la cola del admin. Un modelo 10 % peor son cien correcciones por pallet, y eso se come el ahorro entero.

Diferencia técnica real: Gemini puede apoyarse en búsqueda de Google, lo que para "cuánto cuesta esto nuevo en México" es una ventaja sobre un modelo que responde de memoria. Cuesta latencia, y aquí la latencia no importa porque el análisis corre en segundo plano.

Punto de partida: `claude-haiku-4-5`, decidido con la prueba del paso 3.

Un análisis fallido deja la fila en `error` con su foto intacta. Nunca se borra una foto por un fallo de análisis.

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
