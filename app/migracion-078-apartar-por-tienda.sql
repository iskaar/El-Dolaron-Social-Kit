-- Apartar de cualquier tienda y recoger donde elija el cliente (Issue #800, parte 4 de #793; regla R7). Aditiva: columnas con valor por omisión.
-- Requiere las migraciones 076 y 077. `productos.stock` sigue siendo lo que hay en Soledad; lo de una sucursal vive en existencia_tienda.
-- Una pieza apartada ya salió de la existencia de la tienda donde estaba (pedido_lineas.tienda): cancelar o vencer la regresa AHÍ, una sola vez.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-078-apartar-por-tienda.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-078-apartar-por-tienda.sql

-- La tienda donde el cliente recoge. En un envío es la tienda que envía (hoy solo Soledad).
alter table pedidos add column recoge_en text not null default 'soledad';

-- Dónde está (o hacia dónde va) la unidad apartada, y las marcas con hora y autor de cada paso de su camino.
-- separada: alguien la apartó físicamente. enviada: la tienda de origen la mandó (desde `enviada_desde`; `tienda` pasa a ser el destino).
-- llego: el destino la recibió. regresada: volvió al piso tras cancelarse o vencer el apartado.
alter table pedido_lineas add column tienda text not null default 'soledad';
alter table pedido_lineas add column separada_en text;
alter table pedido_lineas add column separada_por text;
alter table pedido_lineas add column enviada_en text;
alter table pedido_lineas add column enviada_por text;
alter table pedido_lineas add column enviada_desde text;
alter table pedido_lineas add column llego_en text;
alter table pedido_lineas add column llego_por text;
alter table pedido_lineas add column regresada_en text;
alter table pedido_lineas add column regresada_por text;

-- Lo apartado hasta hoy salió de Soledad y su pedido se recoge ahí: no debe aparecer como «por separar» ni «por regresar» de golpe.
update pedido_lineas set separada_en = (select creado_en from pedidos where id = pedido_lineas.pedido_id), separada_por = 'migracion-078';
update pedido_lineas set regresada_en = (select actualizado_en from pedidos where id = pedido_lineas.pedido_id), regresada_por = 'migracion-078'
  where pedido_id in (select id from pedidos where estado in ('cancelado', 'vencido'));

-- Los avisos de cada tienda leen los renglones de pedidos abiertos por tienda.
create index if not exists pedido_lineas_tienda on pedido_lineas (tienda, pedido_id);
