-- Apartados y paquetes de envío (Issue #434). Antes se llamó 048: renumerada a 056 al ponerse al día con main.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- (--file falla con error 10000 en /import y cmd corta el SQL en el primer salto de línea:
-- se manda en una línea, sin comentarios. Por eso aquí no hay comentarios al final de una línea.)
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-056-apartados.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-056-apartados.sql | tr '\n' ' ')"
-- ANTES de producción: tomar y guardar un bookmark de D1 Time Travel para recuperación.
-- Ejecutar una sola vez y como archivo completo. Conserva el anticipo y su corte histórico.
-- NO ES REPETIBLE y no debe serlo: reconstruye pedidos y agrega columnas (add column no admite
-- if not exists). Para que un segundo intento no destruya nada, la PRIMERA sentencia que cambia
-- algo crea pedido_movimientos sin «if not exists»: si la migración ya corrió (también como 048,
-- como en sandbox el 22/10), falla ahí con «table pedido_movimientos already exists» y no toca
-- nada más. Ese error significa «ya estaba aplicada». Poner «if not exists» en las demás sería
-- peor: un segundo pase perdería revision, liquidado_en y el precio pactado de cada línea.
-- Isaac autorizó reconstruir pedidos el 22/10/2026 (#434): el mínimo de tienda
-- es 15% al peso hacia arriba, validado por el servidor con las piezas, sin piso de $100.
-- D1 mantiene las FK activas en su transacción implícita: foreign_keys=off no sirve.
-- Como en 039, se difieren las comprobaciones y se apartan las hijas antes del DROP.
-- ventas.pedido_id admite NULL: se guarda/restaura solo ese vínculo, sin tocar tickets,
-- sus índices/triggers ni sus propias hijas. pedido_movimientos nace vacía y vale como ventas:
-- su FK nombra «pedidos» y vuelve a apuntar a la tabla nueva tras el RENAME.
-- FK entrantes hasta 055: pedido_lineas.pedido_id y ventas.pedido_id (035).
-- La vista movimientos_existencia (054) lee pedidos y pedido_lineas: SQLite rechaza el RENAME
-- mientras una vista apunta a una tabla borrada, así que se quita y se recrea idéntica al final.
-- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
pragma defer_foreign_keys = on;

create table pedido_movimientos (
  -- id: UUID del navegador, igual aunque se pierda la respuesta; solicitud: mismo id con otro contenido = 409.
  id text primary key,
  pedido_id text not null references pedidos(id),
  tipo text not null check (tipo in ('pieza', 'abono')),
  solicitud text not null,
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

drop view if exists movimientos_existencia;

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
-- La 057 (#431, antes 047) crea este índice sobre pedido_lineas; si ya corrió, el DROP de arriba lo borra.
create index if not exists pedido_lineas_producto on pedido_lineas (producto_id, pedido_id);
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

-- Igual que en 054, carácter por carácter.
create view if not exists movimientos_existencia as
  select * from (
    select a.producto_id, a.motivo as tipo, a.despues - a.antes as cantidad, a.antes as antes, a.despues as despues,
           a.ajustado_por as por, a.ajustado_en as en, a.id as referencia
      from conteo_ajustes a
    union all
    select l.producto_id, 'venta', -l.cantidad, null, null, v.cajero, v.registrado_en, v.id
      from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0
    union all
    select l.producto_id, 'cancelacion_venta', l.cantidad - l.cancelada_cantidad, null, null, v.cancelada_por, v.cancelada_en, v.id
      from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0 and v.cancelada = 1 and l.cantidad > l.cancelada_cantidad
    union all
    select l.producto_id, 'devolucion', d.cantidad, null, null, d.autor, d.creado_en, d.venta_id
      from devoluciones d join venta_lineas l on l.id = d.linea_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0
    union all
    select m.producto_id, 'mercadolibre', -m.descontado, null, null, 'mercadolibre', m.recibido_en, m.order_id
      from ml_ventas m
     where m.estado = 'descontada' and m.descontado > 0
  )
  union all
  select * from (
    select pl.producto_id, 'apartado', -pl.cantidad, null, null, pe.vendedora, pe.creado_en, 'P-' || pe.folio
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id
    union all
    select pl.producto_id, 'apartado_liberado', pl.cantidad, null, null, '', pe.actualizado_en, 'P-' || pe.folio
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id
     where pe.estado in ('cancelado', 'vencido')
    union all
    select pl.producto_id, 'apartado_a_venta', pl.cantidad, null, null, v.cajero, v.registrado_en, v.id
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id join ventas v on v.id = pe.venta_id
     where pe.estado = 'vendido'
  );
