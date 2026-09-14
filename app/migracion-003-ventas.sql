-- Caja: ventas, sus lineas, y los tres productos de bin.
-- Correr una vez:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-003-ventas.sql

create table if not exists ventas (
  id             text primary key,          -- crypto.randomUUID() de la caja, para idempotencia
  total          integer not null,          -- centavos MXN
  forma_pago     text not null,             -- efectivo|tarjeta
  efectivo       integer not null default 0,
  cambio         integer not null default 0,
  creado_en      text not null,             -- hora de la venta en la caja, no del servidor
  registrado_en  text not null              -- cuando llego al servidor; difiere si hubo red caida
);

create table if not exists venta_lineas (
  id          integer primary key autoincrement,
  venta_id    text not null references ventas(id),
  producto_id text,                          -- nulo si la pieza ya no existe
  codigo      text not null,
  nombre      text not null,
  precio      integer not null,              -- centavos, congelado al momento de la venta
  cantidad    integer not null default 1
);

create index if not exists venta_lineas_venta on venta_lineas (venta_id);
create index if not exists ventas_creado on ventas (creado_en);

-- Los tres botes. Son productos como cualquier otro para la caja, pero no
-- descuentan existencias: nadie cuenta cuantas piezas quedan en un bote.
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en)
values
  ('00000000-0000-4000-8000-000000000020', 'BIN-20', 'Bin $20', 'otros', 0, 2000, 'nuevo',
   'listo', 'bin_20', 0, 1, 'S00', '', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000040', 'BIN-40', 'Bin $40', 'otros', 0, 4000, 'nuevo',
   'listo', 'bin_40', 0, 1, 'S00', '', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000060', 'BIN-60', 'Bin $60', 'otros', 0, 6000, 'nuevo',
   'listo', 'bin_60', 0, 1, 'S00', '', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z')
on conflict (id) do nothing;
