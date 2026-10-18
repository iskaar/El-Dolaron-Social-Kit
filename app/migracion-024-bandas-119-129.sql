-- Bandas de $119 y $129 (Issue #168): de siete a nueve montos por familia.
-- Correr una vez, antes de desplegar el codigo que los ofrece (si no, /bandas
-- imprimiria codigos como JU119 que la caja no encuentra). Primero en el
-- sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-024-bandas-119-129.sql
--
-- Es repetible: cada insert se salta lo que ya existe. Las familias que se den
-- de alta despues desde /bandas ya nacen con los nueve montos (crearFamilia).

-- El precio de cada banda vive en la configuracion, igual que el de las demas.
insert or ignore into config (clave, valor) values
  ('banda_119', '11900'),
  ('banda_129', '12900');

-- Dos productos de catalogo por familia, como en la 009: sin existencias
-- (sin_inventario = 1, stock = 0), con el precio de la configuracion.
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en)
select lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
             || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       upper(f.prefijo) || m.monto,
       f.nombre || ' $' || m.monto,
       'otros', 0,
       coalesce((select cast(valor as integer) from config where clave = 'banda_' || m.monto), m.monto * 100),
       'nuevo', 'listo', 'banda_' || f.prefijo || m.monto, 0, 1, 'S00', '',
       '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z'
from familias f
cross join (select column1 as monto from (values (119), (129))) m
where not exists (select 1 from productos p where p.codigo = upper(f.prefijo) || m.monto);
