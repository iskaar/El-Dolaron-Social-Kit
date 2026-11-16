-- Existencias por sucursal y bultos (Issue #795, parte 2 de 3 de #793). Aditiva: tablas nuevas, columnas con valor por omisión y la vista
-- movimientos_existencia recreada con la columna `tienda`. `productos.stock` conserva su significado: lo que hay físicamente en Soledad.
-- Lo que está en una sucursal vive en existencia_tienda; lo que va en un bulto abierto o cerrado no es de ninguna tienda hasta recibirse.
-- Requiere la migración 076 (usuarios.tienda, ventas.tienda).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-077-existencias-bultos.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-077-existencias-bultos.sql

-- Unidades de una pieza en una sucursal (Soledad no entra aquí: es productos.stock). Nunca negativa: el trigger da el mensaje y el CHECK es el respaldo.
create table if not exists existencia_tienda (
  producto_id text not null references productos(id),
  tienda text not null check (tienda <> '' and tienda <> 'soledad'),
  unidades integer not null default 0 check (unidades >= 0),
  actualizado_en text not null,
  primary key (producto_id, tienda)
) without rowid;
create index if not exists existencia_tienda_cambios on existencia_tienda (tienda, actualizado_en);

create trigger if not exists existencia_tienda_no_negativa
before update of unidades on existencia_tienda
for each row when new.unidades < 0
begin
  select raise(abort, 'existencia insuficiente en la tienda');
end;

-- Un bulto: abierto (se arma) → cerrado (en camino) → recibido; un bulto abierto se puede cancelar (todo vuelve al origen).
-- `transicion` es el token del intento que lo movió de estado: las sentencias que mueven existencia lo comparan, así que un reintento no suma dos veces.
create table if not exists bultos (
  id text primary key,
  folio text not null unique,
  origen text not null,
  destino text not null check (destino <> origen),
  estado text not null default 'abierto' check (estado in ('abierto', 'cerrado', 'recibido', 'cancelado')),
  creado_por text not null,
  creado_en text not null,
  cerrado_por text,
  cerrado_en text,
  recibido_por text,
  recibido_en text,
  cancelado_por text,
  cancelado_en text,
  transicion text not null default ''
);
create index if not exists bultos_estado on bultos (estado, destino);

-- Cada escaneo al armar es un renglón con su UUID: reintentar no mete dos veces. Quitar una pieza la marca, no la borra.
create table if not exists bulto_lineas (
  id text primary key,
  bulto_id text not null references bultos(id),
  producto_id text not null references productos(id),
  cantidad integer not null check (cantidad between 1 and 999),
  creado_por text not null,
  creado_en text not null,
  quitada_en text,
  quitada_por text,
  quitada_intento text
);
create index if not exists bulto_lineas_bulto on bulto_lineas (bulto_id);
create index if not exists bulto_lineas_pieza on bulto_lineas (producto_id) where quitada_en is null;

create trigger if not exists bulto_linea_en_abierto
before insert on bulto_lineas
for each row when (select estado from bultos where id = new.bulto_id) is not 'abierto'
begin
  select raise(abort, 'bulto no abierto');
end;

-- Las piezas de banda y los botes (sin_inventario) no cuentan existencia: viajan sin escanear. Tampoco una pieza descartada o sin etiqueta.
create trigger if not exists bulto_linea_contable
before insert on bulto_lineas
for each row when exists (select 1 from productos where id = new.producto_id
  and (sin_inventario = 1 or estado_analisis = 'descartado' or coalesce(codigo, '') = ''))
begin
  select raise(abort, 'pieza sin existencia contable');
end;

create trigger if not exists bulto_linea_quitar_en_abierto
before update of quitada_en on bulto_lineas
for each row when old.quitada_en is null and new.quitada_en is not null
  and (select estado from bultos where id = new.bulto_id) is not 'abierto'
begin
  select raise(abort, 'bulto no abierto');
end;

create trigger if not exists bulto_estado_valido
before update of estado on bultos
for each row when not ((old.estado = 'abierto' and new.estado in ('cerrado', 'cancelado'))
  or (old.estado = 'cerrado' and new.estado = 'recibido'))
begin
  select raise(abort, 'transicion de bulto invalida');
end;

create trigger if not exists bulto_no_vacio
before update of estado on bultos
for each row when new.estado = 'cerrado'
  and not exists (select 1 from bulto_lineas where bulto_id = new.id and quitada_en is null)
begin
  select raise(abort, 'bulto vacio');
end;

-- Rastro por tienda: el ajuste de una sucursal queda en conteo_ajustes con su tienda; el historial es de Soledad.
alter table conteo_ajustes add column tienda text not null default 'soledad';
-- La tienda donde se canceló o devolvió: ahí entra la pieza (R3 de #793).
alter table ventas add column cancelada_tienda text not null default 'soledad';
alter table devoluciones add column tienda text not null default 'soledad';

-- Igual que en 056, más `tienda` (la existencia que mueve cada renglón) y las salidas y entradas por bulto.
drop view if exists movimientos_existencia;
create view movimientos_existencia as
  select * from (
    select a.producto_id, a.motivo as tipo, a.despues - a.antes as cantidad, a.antes as antes, a.despues as despues,
           a.ajustado_por as por, a.ajustado_en as en, a.id as referencia, a.tienda as tienda
      from conteo_ajustes a
    union all
    select l.producto_id, 'venta', -l.cantidad, null, null, v.cajero, v.registrado_en, v.id, v.tienda
      from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0
    union all
    select l.producto_id, 'cancelacion_venta', l.cantidad - l.cancelada_cantidad, null, null, v.cancelada_por, v.cancelada_en, v.id, v.cancelada_tienda
      from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0 and v.cancelada = 1 and l.cantidad > l.cancelada_cantidad
    union all
    select l.producto_id, 'devolucion', d.cantidad, null, null, d.autor, d.creado_en, d.venta_id, d.tienda
      from devoluciones d join venta_lineas l on l.id = d.linea_id join productos p on p.id = l.producto_id
     where p.sin_inventario = 0
    union all
    select m.producto_id, 'mercadolibre', -m.descontado, null, null, 'mercadolibre', m.recibido_en, m.order_id, 'soledad'
      from ml_ventas m
     where m.estado = 'descontada' and m.descontado > 0
  )
  union all
  select * from (
    select pl.producto_id, 'apartado', -pl.cantidad, null, null, pe.vendedora, pe.creado_en, 'P-' || pe.folio, 'soledad'
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id
    union all
    select pl.producto_id, 'apartado_liberado', pl.cantidad, null, null, '', pe.actualizado_en, 'P-' || pe.folio, 'soledad'
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id
     where pe.estado in ('cancelado', 'vencido')
    union all
    select pl.producto_id, 'apartado_a_venta', pl.cantidad, null, null, v.cajero, v.registrado_en, v.id, 'soledad'
      from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id join ventas v on v.id = pe.venta_id
     where pe.estado = 'vendido'
  )
  union all
  select * from (
    select l.producto_id, 'bulto_salida', -l.cantidad, null, null, l.creado_por, l.creado_en, b.folio, b.origen
      from bulto_lineas l join bultos b on b.id = l.bulto_id
    union all
    select l.producto_id, 'bulto_regreso', l.cantidad, null, null, l.quitada_por, l.quitada_en, b.folio, b.origen
      from bulto_lineas l join bultos b on b.id = l.bulto_id
     where l.quitada_en is not null
    union all
    select l.producto_id, 'bulto_cancelado', l.cantidad, null, null, b.cancelado_por, b.cancelado_en, b.folio, b.origen
      from bulto_lineas l join bultos b on b.id = l.bulto_id
     where b.estado = 'cancelado' and l.quitada_en is null
    union all
    select l.producto_id, 'bulto_entrada', l.cantidad, null, null, b.recibido_por, b.recibido_en, b.folio, b.destino
      from bulto_lineas l join bultos b on b.id = l.bulto_id
     where b.estado = 'recibido' and l.quitada_en is null
  );
