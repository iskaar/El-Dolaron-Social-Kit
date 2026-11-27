-- Bandas de $250 y $300 (Issue #934), igual que la 085: config del precio y un producto de
-- catalogo por familia, sin existencias, con el propietario de la familia. No toca nada existente.
--
-- Correr una vez, ANTES de desplegar el codigo que los ofrece (si no, /bandas imprimiria
-- R250 o R300 que la caja no encuentra). Primero en el sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-091-bandas-250-300.sql
--
-- Es repetible: cada insert se salta lo que ya existe. actualizado_en de hoy para que la caja
-- las reciba; creado_en vieja para no tapar las piezas de verdad en /vender (ver la 085).

insert or ignore into config (clave, valor) values
  ('banda_250', '25000'),
  ('banda_300', '30000');

insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en, propietario)
select lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
             || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       upper(f.prefijo) || m.monto,
       f.nombre || ' $' || m.monto,
       'otros', 0,
       coalesce((select cast(valor as integer) from config where clave = 'banda_' || m.monto), m.monto * 100),
       'nuevo', 'listo', 'banda_' || f.prefijo || m.monto, 0, 1, 'S00', '',
       '2026-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       f.propietario
from familias f
cross join (select column1 as monto from (values (250), (300))) m
where not exists (select 1 from productos p where p.codigo = upper(f.prefijo) || m.monto);
