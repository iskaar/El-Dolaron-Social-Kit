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

Modelo por defecto: **`claude-opus-5`**. Costo aproximado por foto (≈1.5 k tokens de entrada, ≈300 de salida): **$0.015 USD**, unos $15 USD por pallet de mil piezas.

Si ese número te parece alto para el volumen, **`claude-haiku-4-5`** hace el mismo trabajo a ~$0.003 por foto, cerca de $3 USD por pallet. Es tu decisión, no la de Codex: se cambia en una constante. Empezar en Opus y bajar si la calidad aguanta es el orden correcto, porque un nombre mal leído cuesta corrección manual en la cola.

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
3. Análisis con `waitUntil` y la fila pasando de `pendiente` a `listo`.
4. Cola del admin: revisión, edición, cálculo de precio y asignación a bin.
5. Etiquetas por lote con Code128 y la semana de ingreso.

Cada paso se prueba desplegado, con teléfono real, antes de pasar al siguiente.

## Fuera de alcance

Durable Objects, colas, framework de frontend, Vite, autenticación propia, catálogo público, integración de pagos, y cualquier cosa que guarde una segunda cantidad de existencias.
