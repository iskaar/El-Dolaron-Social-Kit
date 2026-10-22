-- Interesados por WhatsApp (Issue #431). Aditiva; «La quiere» no cambia stock.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-047-interesados.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-047-interesados.sql
create table if not exists interesados (
  id text primary key,
  -- Cola temporal: borrar/fusionar una pieza no bloquea inventario ni deja anotaciones huérfanas.
  producto_id text not null references productos(id) on delete cascade,
  cliente text not null check (length(cliente) between 1 and 80),
  telefono text not null default '' check (telefono = '' or (length(telefono) = 10 and telefono not glob '*[^0-9]*')),
  nota text not null default '' check (length(nota) <= 500),
  vendedora text not null,
  estado text not null default 'abierto' check (estado in ('abierto', 'descartado')),
  creado_en text not null,
  actualizado_en text not null
);
create index if not exists interesados_producto_estado on interesados (producto_id, estado, creado_en);
create index if not exists interesados_vendedora on interesados (vendedora, creado_en);
-- La cola compartida y el estado de cada pieza también necesitan búsquedas indexadas.
create index if not exists interesados_estado on interesados (estado, creado_en);
create index if not exists pedido_lineas_producto on pedido_lineas (producto_id, pedido_id);
