-- Carga del inventario de Avenida Salk por precio (conteo a mano del 2026-11-18: hoja de piso + hoja de bodega).
-- Un producto genérico por precio ("General $100", código SK100: no G100, para no chocar con las bandas de la familia General), con existencia normal (sin_inventario = 0) que vive solo en
-- existencia_tienda de 'salk'; productos.stock = 0 porque en Soledad no hay. La caja de Salk descuenta al cobrar.
-- Nombre "General $N": NOMBRE_INTERNO de catalogo.ts lo deja fuera del sitio, y Mercado Libre exige stock en Soledad.
-- Es repetible: no crea dos veces un código y la existencia se FIJA al conteo (no suma).
-- Isaac ejecuta, primero en sandbox y luego en producción:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=carga-salk-genericos.sql
--   npx wrangler d1 execute el-dolaron --remote --file=carga-salk-genericos.sql

-- El conteo (piso, bodega) va como CTE en cada sentencia: D1 no permite tablas temporales (SQLITE_AUTH).
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico, estado_analisis, destino, stock,
                       sin_inventario, semana_ingreso, foto_key, creado_en, actualizado_en, capturado_por, modificado_por)
with conteo_salk (monto, piso, bodega) as (values
  (10, 6, 0), (15, 43, 0), (20, 493, 249), (25, 13, 0), (30, 146, 12), (40, 83, 11), (50, 157, 50), (60, 56, 0),
  (70, 144, 0), (75, 8, 0), (80, 65, 5), (90, 10, 0), (100, 355, 189), (120, 17, 0), (125, 37, 0), (130, 1, 0),
  (140, 1, 0), (150, 468, 89), (170, 1, 0), (175, 8, 0), (180, 2, 0), (200, 102, 87), (225, 2, 0), (250, 9, 34),
  (275, 1, 0), (300, 8, 3), (400, 11, 0), (430, 1, 0), (500, 1, 0), (550, 5, 0), (650, 1, 0), (900, 2, 0),
  (1950, 1, 0), (2750, 1, 0))
select lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
             || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       'SK' || c.monto, 'General $' || c.monto, 'otros', 0, c.monto * 100, 'nuevo', 'listo', 'etiqueta', 0, 0, 'S47', '',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'conteo-salk', 'conteo-salk'
from conteo_salk c
where not exists (select 1 from productos p where p.codigo = 'SK' || c.monto);

insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en)
with conteo_salk (monto, piso, bodega) as (values
  (10, 6, 0), (15, 43, 0), (20, 493, 249), (25, 13, 0), (30, 146, 12), (40, 83, 11), (50, 157, 50), (60, 56, 0),
  (70, 144, 0), (75, 8, 0), (80, 65, 5), (90, 10, 0), (100, 355, 189), (120, 17, 0), (125, 37, 0), (130, 1, 0),
  (140, 1, 0), (150, 468, 89), (170, 1, 0), (175, 8, 0), (180, 2, 0), (200, 102, 87), (225, 2, 0), (250, 9, 34),
  (275, 1, 0), (300, 8, 3), (400, 11, 0), (430, 1, 0), (500, 1, 0), (550, 5, 0), (650, 1, 0), (900, 2, 0),
  (1950, 1, 0), (2750, 1, 0))
select p.id, 'salk', c.piso + c.bodega, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from conteo_salk c join productos p on p.codigo = 'SK' || c.monto
where true
on conflict (producto_id, tienda) do update set unidades = excluded.unidades, actualizado_en = excluded.actualizado_en;

-- Comprobación: debe dar 34 precios, 2,988 piezas (2,259 piso + 729 bodega) y $269,880 a precio de etiqueta.
select count(*) as precios, sum(e.unidades) as piezas, sum(e.unidades * p.precio) / 100 as valor_pesos
from existencia_tienda e join productos p on p.id = e.producto_id
where e.tienda = 'salk' and p.codigo like 'SK%';
