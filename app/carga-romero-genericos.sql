-- Carga del inventario de Coronel Romero por precio (conteo a mano del 2026-11-18, módulos 1 a 13). Mismo ejercicio que
-- carga-salk-genericos.sql: un producto genérico por precio ("General $100", código CR100), con existencia normal
-- (sin_inventario = 0) que vive solo en existencia_tienda de 'romero'; productos.stock = 0 porque en Soledad no hay.
-- Código CR (Coronel Romero): no G<N> (bandas de General) ni SK (Salk); producción no tenía códigos CR al prepararlo.
-- Es repetible: no crea dos veces un código y la existencia se FIJA al conteo (no suma; se perdería lo vendido).
-- Isaac ejecuta, primero en sandbox y luego en producción:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=carga-romero-genericos.sql
--   npx wrangler d1 execute el-dolaron --remote --file=carga-romero-genericos.sql

-- El conteo va renglón por renglón de la libreta (módulo, precio, piezas) para poder cotejarlo; un precio puede
-- repetirse en el mismo módulo (así viene en la hoja). Va como CTE en cada sentencia: D1 no permite tablas temporales.
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico, estado_analisis, destino, stock,
                       sin_inventario, semana_ingreso, foto_key, creado_en, actualizado_en, capturado_por, modificado_por)
with libreta (modulo, monto, piezas) as (values
  (1, 25, 2), (1, 30, 53), (1, 40, 29), (1, 50, 29), (1, 20, 16), (1, 100, 11), (1, 150, 9), (1, 200, 2),
  (1, 5, 5), (1, 70, 1), (1, 80, 1),
  (2, 30, 8), (2, 50, 30), (2, 100, 5), (2, 80, 6), (2, 150, 2), (2, 25, 13), (2, 20, 23), (2, 70, 2), (2, 5, 2),
  (3, 25, 6), (3, 30, 8), (3, 40, 3), (3, 20, 6), (3, 25, 9), (3, 10, 1), (3, 50, 17), (3, 100, 10), (3, 60, 6),
  (3, 80, 6), (3, 120, 1), (3, 150, 4),
  (4, 40, 4), (4, 50, 25), (4, 100, 6), (4, 150, 6), (4, 20, 6), (4, 30, 8), (4, 20, 1), (4, 25, 11), (4, 35, 1),
  (4, 80, 1),
  (5, 50, 48), (5, 100, 8), (5, 15, 7), (5, 60, 1), (5, 30, 5), (5, 20, 1), (5, 200, 3), (5, 120, 12), (5, 70, 1),
  (6, 100, 10), (6, 150, 9), (6, 25, 16), (6, 50, 14), (6, 30, 2), (6, 20, 1), (6, 40, 4), (6, 250, 1), (6, 60, 2),
  (7, 100, 11), (7, 50, 29), (7, 70, 3), (7, 30, 1), (7, 150, 5), (7, 25, 25), (7, 20, 2),
  (8, 150, 3), (8, 100, 10), (8, 50, 6), (8, 40, 5), (8, 30, 17), (8, 25, 20),
  (9, 40, 52), (9, 20, 10),
  (10, 30, 14), (10, 50, 22), (10, 40, 6), (10, 60, 1), (10, 200, 4), (10, 120, 1), (10, 100, 5),
  (11, 50, 2), (11, 20, 24), (11, 5, 19), (11, 40, 9), (11, 15, 3), (11, 30, 3),
  (12, 100, 14), (12, 50, 13), (12, 40, 8), (12, 200, 2), (12, 150, 10),
  (13, 100, 7), (13, 60, 7), (13, 40, 5), (13, 50, 17), (13, 80, 4), (13, 150, 9), (13, 30, 1), (13, 120, 1))
select lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
             || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       'CR' || c.monto, 'General $' || c.monto, 'otros', 0, c.monto * 100, 'nuevo', 'listo', 'etiqueta', 0, 0, 'S47', '',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'conteo-romero', 'conteo-romero'
from (select distinct monto from libreta) c
where not exists (select 1 from productos p where p.codigo = 'CR' || c.monto);

insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en)
with libreta (modulo, monto, piezas) as (values
  (1, 25, 2), (1, 30, 53), (1, 40, 29), (1, 50, 29), (1, 20, 16), (1, 100, 11), (1, 150, 9), (1, 200, 2),
  (1, 5, 5), (1, 70, 1), (1, 80, 1),
  (2, 30, 8), (2, 50, 30), (2, 100, 5), (2, 80, 6), (2, 150, 2), (2, 25, 13), (2, 20, 23), (2, 70, 2), (2, 5, 2),
  (3, 25, 6), (3, 30, 8), (3, 40, 3), (3, 20, 6), (3, 25, 9), (3, 10, 1), (3, 50, 17), (3, 100, 10), (3, 60, 6),
  (3, 80, 6), (3, 120, 1), (3, 150, 4),
  (4, 40, 4), (4, 50, 25), (4, 100, 6), (4, 150, 6), (4, 20, 6), (4, 30, 8), (4, 20, 1), (4, 25, 11), (4, 35, 1),
  (4, 80, 1),
  (5, 50, 48), (5, 100, 8), (5, 15, 7), (5, 60, 1), (5, 30, 5), (5, 20, 1), (5, 200, 3), (5, 120, 12), (5, 70, 1),
  (6, 100, 10), (6, 150, 9), (6, 25, 16), (6, 50, 14), (6, 30, 2), (6, 20, 1), (6, 40, 4), (6, 250, 1), (6, 60, 2),
  (7, 100, 11), (7, 50, 29), (7, 70, 3), (7, 30, 1), (7, 150, 5), (7, 25, 25), (7, 20, 2),
  (8, 150, 3), (8, 100, 10), (8, 50, 6), (8, 40, 5), (8, 30, 17), (8, 25, 20),
  (9, 40, 52), (9, 20, 10),
  (10, 30, 14), (10, 50, 22), (10, 40, 6), (10, 60, 1), (10, 200, 4), (10, 120, 1), (10, 100, 5),
  (11, 50, 2), (11, 20, 24), (11, 5, 19), (11, 40, 9), (11, 15, 3), (11, 30, 3),
  (12, 100, 14), (12, 50, 13), (12, 40, 8), (12, 200, 2), (12, 150, 10),
  (13, 100, 7), (13, 60, 7), (13, 40, 5), (13, 50, 17), (13, 80, 4), (13, 150, 9), (13, 30, 1), (13, 120, 1))
select p.id, 'romero', c.piezas, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from (select monto, sum(piezas) as piezas from libreta group by monto) c join productos p on p.codigo = 'CR' || c.monto
where true
on conflict (producto_id, tienda) do update set unidades = excluded.unidades, actualizado_en = excluded.actualizado_en;

-- Comprobación: debe dar 17 precios, 950 piezas y $51,325 a precio de etiqueta.
select count(*) as precios, sum(e.unidades) as piezas, sum(e.unidades * p.precio) / 100 as valor_pesos
from existencia_tienda e join productos p on p.id = e.producto_id
where e.tienda = 'romero' and p.codigo like 'CR%';
