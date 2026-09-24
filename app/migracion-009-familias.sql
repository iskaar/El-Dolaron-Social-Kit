-- Familias de banda: una familia por categoria del plano de la tienda, cada una
-- con sus siete precios ($19 a $199) como productos de catalogo. Ver
-- docs/PLAN-ETIQUETAS-POR-BANDA.md. Sustituye a las dos familias fijas de la
-- migracion 008: Ropa (R) y General (G) se conservan tal cual, con sus codigos.
-- Correr una vez, despues de la 008:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-009-familias.sql
--
-- Es repetible: cada insert se salta lo que ya existe. Las familias que se den
-- de alta despues desde /bandas ("Otro") crean sus siete productos solas.

create table if not exists familias (
  clave     text primary key,
  nombre    text not null,
  prefijo   text not null unique,
  creado_en text not null
);

-- El prefijo es el del codigo de barras: dos letras + el monto (JU49), como
-- maximo 5 caracteres, que es lo que cabe en la etiqueta. Los nombres son
-- cortos por la misma razon: se imprimen arriba de la etiqueta.
insert or ignore into familias (clave, nombre, prefijo, creado_en) values
  ('ropa',               'Ropa',                    'r',  '2026-09-24T00:00:00Z'),
  ('general',            'General',                 'g',  '2026-09-24T00:00:00Z'),
  ('juguetes',           'Juguetes',                'ju', '2026-09-24T00:00:00Z'),
  ('fiesta',             'Fiesta y decoración',     'fi', '2026-09-24T00:00:00Z'),
  ('alimentos',          'Alimentos y bebidas',     'al', '2026-09-24T00:00:00Z'),
  ('desechables',        'Desechables y mesa',      'de', '2026-09-24T00:00:00Z'),
  ('asador',             'Asador y exterior',       'as', '2026-09-24T00:00:00Z'),
  ('mascotas',           'Mascotas',                'ma', '2026-09-24T00:00:00Z'),
  ('manualidades',       'Manualidades',            'mn', '2026-09-24T00:00:00Z'),
  ('papeleria',          'Papelería y escolar',     'pa', '2026-09-24T00:00:00Z'),
  ('regalos',            'Regalos y empaque',       're', '2026-09-24T00:00:00Z'),
  ('limpieza',           'Limpieza y consumibles',  'li', '2026-09-24T00:00:00Z'),
  ('calzado',            'Calzado',                 'ca', '2026-09-24T00:00:00Z'),
  ('botadero',           'Botadero',                'bo', '2026-09-24T00:00:00Z'),
  ('cuidado-personal',   'Cuidado personal y bebé', 'cu', '2026-09-24T00:00:00Z'),
  ('cocina',             'Cocina y organización',   'co', '2026-09-24T00:00:00Z'),
  ('blancos',            'Blancos y textiles',      'bl', '2026-09-24T00:00:00Z'),
  ('electronica-ligera', 'Electrónica ligera',      'el', '2026-09-24T00:00:00Z');

-- Siete productos por familia. Ropa y General ya existen (008) y se saltan por
-- su codigo. sin_inventario = 1 y stock = 0: no descuentan existencias. El
-- precio sale de la configuracion (banda_19 ... banda_199), con el monto por
-- defecto si falta. El id es un UUID v4 al azar, como el de cualquier producto.
-- Los montos van en VALUES y no en union all: D1 topa los SELECT compuestos en 5 terminos.
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
       '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'
from familias f
cross join (select column1 as monto from (values (19), (29), (49), (79), (99), (149), (199))) m
where not exists (select 1 from productos p where p.codigo = upper(f.prefijo) || m.monto);
