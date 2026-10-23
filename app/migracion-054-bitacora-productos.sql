-- Bitacora de cambios por pieza (Issue #485, U4 de la auditoria #478, P3-2). Aditiva.
-- Hasta hoy solo quedaba `precio_anterior` (una sola version). Ahora cada cambio de nombre,
-- marca, talla, categoria, precio, precio de lista, destino, grado, UPC, codigo o estado de
-- analisis deja un renglon en `productos_cambios`, venga de la ruta que venga.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-054-bitacora-productos.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-054-bitacora-productos.sql
--
-- No es repetible del todo: SQLite no tiene `add column if not exists`, asi que `modificado_por`
-- falla si se corre de nuevo (ya esta, no pasa nada). Todo lo demas es `if not exists`.
--
-- Quien: los handlers ponen `modificado_por = <correo>` (o 'ia', 'cola', 'cron', 'sistema') en el
-- mismo UPDATE que cambia la pieza, y el trigger lo copia a `por`.
--
-- Atribucion obsoleta: `modificado_por` vive en la fila, y un UPDATE posterior que no lo ponga
-- se le cargaria a la persona anterior. Por eso el MISMO trigger, despues de registrar, lo
-- devuelve a '' (un solo trigger y no dos: SQLite no garantiza el orden entre triggers del mismo
-- evento, y el reinicio nunca debe correr antes del registro). Escucha tambien `modificado_por`
-- para que ponerlo sin tocar otra columna tampoco deje rastro viejo. El reinicio no puede ciclar:
-- si recursive_triggers estuviera activo, la segunda pasada no ve cambios en las columnas
-- vigiladas (no registra nada) y su `where modificado_por <> ''` ya no encuentra fila.
--
-- D1 admite 5 terminos por SELECT compuesto: por eso son once INSERT y no un union all, y la vista agrupa sus fuentes de a cinco como maximo.
-- Una venta, un apartado o una devolucion solo cambian `stock` y `actualizado_en`, que el trigger
-- no escucha: el camino caliente de la caja no paga nada. `en` es la hora del trigger (no
-- `actualizado_en`, que no todos los UPDATE ponen) y tiene el formato de new Date().toISOString().
-- Los INSERT no se registran: el alta es la fila misma. Los DELETE tampoco: sus renglones
-- quedan, huerfanos a proposito, como rastro de piezas fusionadas o descartadas.

create table if not exists productos_cambios (
  id          integer primary key autoincrement,
  producto_id text not null,
  campo       text not null,                 -- nombre|marca|talla|categoria|precio|precio_lista|destino|estado_fisico|upc|codigo|estado_analisis
  antes       text,                          -- como texto, precios en centavos. Nulo = no tenia valor
  despues     text,
  por         text not null default '',      -- correo, o ia|cola|cron|sistema. Vacio = un UPDATE que no dijo quien
  en          text not null                  -- ISO UTC
);

create index if not exists productos_cambios_pieza on productos_cambios (producto_id, en);

alter table productos add column modificado_por text not null default '';

create trigger if not exists productos_bitacora
after update of nombre, marca, talla, categoria, precio, precio_lista, destino, estado_fisico, upc, codigo, estado_analisis, modificado_por on productos
for each row
begin
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'nombre', cast(old.nombre as text), cast(new.nombre as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.nombre is not new.nombre;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'marca', cast(old.marca as text), cast(new.marca as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.marca is not new.marca;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'talla', cast(old.talla as text), cast(new.talla as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.talla is not new.talla;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'categoria', cast(old.categoria as text), cast(new.categoria as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.categoria is not new.categoria;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'precio', cast(old.precio as text), cast(new.precio as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.precio is not new.precio;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'precio_lista', cast(old.precio_lista as text), cast(new.precio_lista as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.precio_lista is not new.precio_lista;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'destino', cast(old.destino as text), cast(new.destino as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.destino is not new.destino;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'estado_fisico', cast(old.estado_fisico as text), cast(new.estado_fisico as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.estado_fisico is not new.estado_fisico;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'upc', cast(old.upc as text), cast(new.upc as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.upc is not new.upc;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'codigo', cast(old.codigo as text), cast(new.codigo as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.codigo is not new.codigo;
  insert into productos_cambios (producto_id, campo, antes, despues, por, en)
    select new.id, 'estado_analisis', cast(old.estado_analisis as text), cast(new.estado_analisis as text), new.modificado_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where old.estado_analisis is not new.estado_analisis;
  update productos set modificado_por = '' where id = new.id and modificado_por <> '';
end;

-- Cada movimiento de existencia de una pieza en un solo lugar: consulta, no escribe. `cantidad`
-- lleva signo (negativo = sale). `antes` y `despues` solo existen donde el documento los guardo
-- (los ajustes de conteo), en los demas son nulos. `referencia` es el id del documento.
-- Fuentes: conteo_ajustes (el tipo es su motivo), venta_lineas con su venta (no cuenta los
-- bins ni el envio, que no descuentan), la cancelacion del ticket y las devoluciones por pieza,
-- los apartados (pedido_lineas) con su liberacion o su paso a venta, y ml_ventas.
-- Dejado fuera a proposito: las ordenes de Mercado Libre `cancelada`, porque ml_ventas no guarda
-- la hora de la cancelacion y el neto es cero. Una orden cancelada tampoco se muestra como salida.
-- Las ventas sin producto (producto_id nulo) no mueven existencia de ninguna pieza.
-- Consultar siempre con `where producto_id = ?`: venta_lineas no tiene indice por pieza.
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
