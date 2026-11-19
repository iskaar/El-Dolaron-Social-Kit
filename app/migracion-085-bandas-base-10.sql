-- Bandas en multiplos de $10 (Issue #869): 20, 30, 40, 50, 70, 80, 100, 120, 130, 150 y 200
-- (antes 19 ... 199). Los codigos y precios de antes NO se tocan: una etiqueta vieja ya pegada
-- (R49, JU199...) se sigue cobrando a lo que dice. Solo se agregan los montos nuevos.
--
-- Correr una vez, ANTES de desplegar el codigo que los ofrece (si no, /bandas imprimiria
-- codigos como R50 que la caja no encuentra). Primero en el sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-085-bandas-base-10.sql
--
-- Es repetible: cada insert se salta lo que ya existe. Las familias que se den de alta
-- despues desde /bandas ya nacen con los montos nuevos (crearFamilia).
-- actualizado_en es la fecha de hoy (no fija) a proposito: la caja pide cambios por esa fecha, y
-- estas bandas tienen que llegarle aunque ya tenga su catalogo cargado. creado_en queda vieja
-- a proposito: /vender recorre las piezas mas recientes primero (240 candidatas por peticion) y
-- ~200 bandas con fecha de hoy taparian las piezas de verdad.

-- El precio de cada banda vive en la configuracion, igual que el de las demas.
insert or ignore into config (clave, valor) values
  ('banda_20', '2000'),
  ('banda_30', '3000'),
  ('banda_40', '4000'),
  ('banda_50', '5000'),
  ('banda_70', '7000'),
  ('banda_80', '8000'),
  ('banda_100', '10000'),
  ('banda_120', '12000'),
  ('banda_130', '13000'),
  ('banda_150', '15000'),
  ('banda_200', '20000');

-- Un producto de catalogo por familia y monto nuevo, como en la 066: sin existencias
-- (sin_inventario = 1, stock = 0), con el precio de la configuracion y el propietario
-- de la familia (067; el de FEP no se mezcla con el de la tienda).
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
cross join (select column1 as monto from (values (20), (30), (40), (50), (70), (80), (100), (120), (130), (150), (200))) m
where not exists (select 1 from productos p where p.codigo = upper(f.prefijo) || m.monto);
