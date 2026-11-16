-- Corregir la forma de pago de un ticket antes del corte (Issue #831). Aditiva: una tabla nueva, sin tocar ninguna existente.
-- Cada corrección (efectivo, tarjeta o transferencia) deja aquí su rastro: qué ticket, de qué forma a cuál, cuánto dinero cambia de forma,
-- cómo estaban `efectivo` y `cambio` antes (la corrección los reescribe), el motivo, quién, en qué caja y tienda, y cuándo.
-- El `id` lo genera la caja al abrir el formulario: reenviar la misma corrección no la duplica.
-- No hay trigger ni columna nueva en `ventas`: la corrección usa el candado `ventas.revision` de la migración 020.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-080-correcciones-pago.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-080-correcciones-pago.sql

create table if not exists correcciones_pago (
  id text primary key,                       -- UUID de la caja: idempotencia
  venta_id text not null references ventas(id),
  forma_anterior text not null check (forma_anterior in ('efectivo', 'tarjeta', 'transferencia')),
  forma_nueva text not null check (forma_nueva in ('efectivo', 'tarjeta', 'transferencia')),
  importe integer not null,                  -- centavos pagados en dinero que cambian de forma (total - Dolarones - anticipo)
  efectivo_anterior integer not null default 0,
  cambio_anterior integer not null default 0,
  motivo text not null,
  autor text not null,                       -- quien tenía la sesión (PIN), nunca del navegador
  caja text not null default '',
  tienda text not null,
  creado_en text not null
);

create index if not exists correcciones_pago_venta on correcciones_pago (venta_id, creado_en);
