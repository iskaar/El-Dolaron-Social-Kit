-- Apartados y paquetes de envío (Issue #434).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-048-apartados.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-048-apartados.sql
-- ANTES de producción: tomar y guardar un bookmark de D1 Time Travel para recuperación.
-- Ejecutar una sola vez y como archivo completo. Conserva el anticipo y su corte histórico.
-- Isaac autorizó reconstruir pedidos el 22/10/2026 (#434): el mínimo de tienda
-- es 15% al peso hacia arriba, validado por el servidor con las piezas, sin piso de $100.
-- D1 mantiene las FK activas en su transacción implícita: foreign_keys=off no sirve.
-- Como en 039, se difieren las comprobaciones y se apartan las hijas antes del DROP.
-- ventas.pedido_id admite NULL: se guarda/restaura solo ese vínculo, sin tocar tickets,
-- sus índices/triggers ni sus propias hijas. pedido_movimientos se crea DESPUÉS.
-- FK entrantes hasta 045: pedido_lineas.pedido_id y ventas.pedido_id (035).
-- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
pragma defer_foreign_keys = on;

create table pedido_lineas_copia as select * from pedido_lineas;
drop table pedido_lineas;
create table pedidos_ventas_copia as select id, pedido_id from ventas where pedido_id is not null;
update ventas set pedido_id = null where pedido_id is not null;

-- Mismo esquema de 035; solo anticipo pierde el mínimo fijo. Las columnas nuevas
-- se agregan después de copiar explícitamente TODAS las columnas históricas.
create table pedidos_nueva (
  id             text primary key,
  folio          integer not null unique,
  cliente        text not null,
  telefono       text not null,
  entrega        text not null check (entrega in ('tienda', 'envio')),
  envio          integer not null default 0,
  vendedora      text not null,
  estado         text not null check (estado in ('apartado', 'vendido', 'vencido', 'cancelado')),
  vence_en       text not null,
  anticipo       integer not null check (anticipo >= 0),
  forma_pago     text not null check (forma_pago in ('efectivo', 'tarjeta', 'transferencia')),
  caja           text not null default '',
  corte_id       text,
  saldo          integer not null check (saldo >= 0),
  saldo_vence_en text not null,
  venta_id       text references ventas(id),
  guia           text not null default '',
  creado_en      text not null,
  actualizado_en text not null
);
insert into pedidos_nueva (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en,
  anticipo, forma_pago, caja, corte_id, saldo, saldo_vence_en, venta_id, guia, creado_en, actualizado_en)
select id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en,
  anticipo, forma_pago, caja, corte_id, saldo, saldo_vence_en, venta_id, guia, creado_en, actualizado_en from pedidos;
drop table pedidos;
alter table pedidos_nueva rename to pedidos;

create trigger pedido_saldo_valido before update of saldo on pedidos
when new.saldo < 0
begin
  select raise(abort, 'saldo de pedido invalido');
end;
create index pedidos_estado on pedidos (estado, vence_en);
create index pedidos_caja_corte on pedidos (caja, corte_id);

create table pedido_lineas (
  pedido_id   text not null references pedidos(id),
  producto_id text not null references productos(id),
  cantidad    integer not null check (cantidad > 0),
  primary key (pedido_id, producto_id)
);
insert into pedido_lineas (pedido_id, producto_id, cantidad)
  select pedido_id, producto_id, cantidad from pedido_lineas_copia;
drop table pedido_lineas_copia;
update ventas set pedido_id = (select pedido_id from pedidos_ventas_copia where id = ventas.id)
  where id in (select id from pedidos_ventas_copia);
drop table pedidos_ventas_copia;

alter table pedidos add column revision integer not null default 0;
alter table pedidos add column liquidado_en text;
alter table pedido_lineas add column precio integer not null default 0 check (precio >= 0 and typeof(precio) = 'integer');

-- Antes se leía el precio del catálogo; desde aquí queda pactado en cada línea.
-- En un envío ya vendido se conserva, si existe, el precio del ticket.
update pedido_lineas set precio = coalesce(
  (select vl.precio from venta_lineas vl join pedidos p on p.venta_id = vl.venta_id
   where p.id = pedido_lineas.pedido_id and vl.producto_id = pedido_lineas.producto_id limit 1),
  (select precio from productos where id = pedido_lineas.producto_id), 0);

-- Los envíos de #269 ya pagados no vuelven a vencer. El corte de jueves usa
-- cuándo se recibió el dinero, aunque el ticket se haya cerrado después.
update pedidos set liquidado_en = case when estado = 'vendido'
  then coalesce((select creado_en from ventas where id = pedidos.venta_id), actualizado_en)
  else creado_en end
where entrega = 'envio' and estado in ('vendido', 'apartado');

create table pedido_movimientos (
  id text primary key,                         -- UUID del navegador, incluso al perder la respuesta
  pedido_id text not null references pedidos(id),
  tipo text not null check (tipo in ('pieza', 'abono')),
  solicitud text not null,                     -- mismo ID con otro contenido responde 409
  importe integer not null check (typeof(importe) = 'integer' and
    ((tipo = 'pieza' and importe = 0) or (tipo = 'abono' and importe > 0))),
  forma_pago text not null,
  caja text not null,
  autor text not null,
  creado_en text not null,
  corte_id text,
  respuesta text not null,
  check (tipo != 'abono' or (caja != '' and forma_pago in ('efectivo', 'tarjeta', 'transferencia')))
);
create index pedido_movimientos_caja_corte on pedido_movimientos (caja, corte_id) where tipo = 'abono';
create index pedido_movimientos_creado on pedido_movimientos (creado_en) where tipo = 'abono';
