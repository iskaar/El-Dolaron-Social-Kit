-- Solicitudes de cambio de precio del capturista al dueño (Issue #451). Aditiva.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-052-solicitudes-precio.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-052-solicitudes-precio.sql
-- Todo el dinero va en centavos MXN enteros. Es repetible: create ... if not exists.
create table if not exists solicitudes_precio (
  id text primary key,                         -- uuid del cliente: reintentar no duplica
  producto_id text not null,
  propietario text not null,                   -- 'dolaron' | 'fep', el de la pieza al pedir
  sentido text not null check (sentido in ('subir', 'bajar')),
  precio_actual integer not null check (precio_actual > 0),
  precio_sugerido integer check (precio_sugerido is null or precio_sugerido > 0),
  nota text not null default '' check (length(nota) <= 140),
  pedido_por text not null,
  pedido_en text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aplicada', 'rechazada')),
  resuelto_por text not null default '',
  resuelto_en text not null default '',
  precio_nuevo integer
);
-- Una sola solicitud pendiente por pieza.
create unique index if not exists solicitudes_precio_una_pendiente
  on solicitudes_precio (producto_id) where estado = 'pendiente';
-- La lista del dueño: pendientes de su propietario, las más viejas primero.
create index if not exists solicitudes_precio_pendientes
  on solicitudes_precio (propietario, pedido_en) where estado = 'pendiente';
