-- Referidos Dolarones, prototipo con conocidos (Issue #489). Aditiva.
-- Reglas de este prototipo en app/src/referidos.ts (50 D al unirse con codigo,
-- 25 D + 25 D al cobrar la primera compra de $150 en dinero, tope de 10 por socio).
--
-- Correr una vez, en sandbox y luego en prod, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-055-referidos.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-055-referidos.sql
--
-- No activa nada por si sola: el programa sigue apagado hasta poner la variable
-- REFERIDOS_TELEFONOS en Cloudflare (lista de telefonos del piloto).

create table if not exists referidos (
  nuevo_id    text primary key references clientes(id),   -- una cuenta se une una sola vez
  referente_id text not null references clientes(id),
  estado      text not null default 'pendiente' check (estado in ('pendiente', 'liberado')),
  venta_id    text,                                       -- la compra de $150 que lo libero
  creado_en   text not null,
  liberado_en text,
  check (nuevo_id <> referente_id)
);
create index if not exists referidos_referente on referidos (referente_id);

-- Tope de 10 personas por socio (un socio por telefono). Si dos altas se pelean el
-- ultimo lugar, la segunda aborta su batch completo (socio, lote y movimiento).
create trigger if not exists referidos_tope
before insert on referidos
when (select count(*) from referidos where referente_id = new.referente_id) >= 10
begin
  select raise(abort, 'tope de referidos');
end;

-- Una venta libera a lo sumo una vez a cada lado, aunque algo la reintente.
create unique index if not exists movimientos_referido_una_vez
  on dolarones_movimientos (cliente_id, venta_id, tipo)
  where tipo in ('referido', 'referido_nuevo');
