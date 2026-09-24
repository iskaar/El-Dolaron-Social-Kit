-- Bandas de precio: reemplazan los tres botes fijos ($20/$40/$60) por siete
-- precios x dos familias (ropa/general), con el limite subido a $200. Ver
-- docs/PLAN-ETIQUETAS-POR-BANDA.md (PR #53) y docs/CONTRATO-ESCANER.md.
-- Correr una vez:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-008-bandas.sql

-- Los tres botes salen del catalogo. Las ventas ya hechas no se rompen:
-- venta_lineas congela codigo/nombre/precio al momento de la venta y no
-- referencia productos con una llave foranea.
delete from productos where id in (
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000040',
  '00000000-0000-4000-8000-000000000060'
);

delete from config where clave in ('limite_bin', 'bin_20', 'bin_40', 'bin_60');

insert into config (clave, valor) values
  ('limite_banda', '20000'),
  ('banda_19',      '1900'),
  ('banda_29',      '2900'),
  ('banda_49',      '4900'),
  ('banda_79',      '7900'),
  ('banda_99',      '9900'),
  ('banda_149',    '14900'),
  ('banda_199',    '19900')
on conflict (clave) do nothing;

-- Las 14 filas de catalogo. Como los botes que reemplazan: sin_inventario = 1
-- (no descuentan existencias), stock = 0, sin foto ni analisis. codigo es lo
-- que escanea la cajera; destino es lo que usa el admin al enrutar una pieza
-- analizada hacia esta banda.
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en)
values
  ('00000000-0000-4000-8000-100000000019', 'R19',  'Ropa $19',     'ropa',  0, 1900,
   'nuevo', 'listo', 'banda_r19',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000029', 'R29',  'Ropa $29',     'ropa',  0, 2900,
   'nuevo', 'listo', 'banda_r29',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000049', 'R49',  'Ropa $49',     'ropa',  0, 4900,
   'nuevo', 'listo', 'banda_r49',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000079', 'R79',  'Ropa $79',     'ropa',  0, 7900,
   'nuevo', 'listo', 'banda_r79',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000099', 'R99',  'Ropa $99',     'ropa',  0, 9900,
   'nuevo', 'listo', 'banda_r99',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000149', 'R149', 'Ropa $149',    'ropa',  0, 14900,
   'nuevo', 'listo', 'banda_r149', 0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-100000000199', 'R199', 'Ropa $199',    'ropa',  0, 19900,
   'nuevo', 'listo', 'banda_r199', 0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000019', 'G19',  'General $19',  'otros', 0, 1900,
   'nuevo', 'listo', 'banda_g19',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000029', 'G29',  'General $29',  'otros', 0, 2900,
   'nuevo', 'listo', 'banda_g29',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000049', 'G49',  'General $49',  'otros', 0, 4900,
   'nuevo', 'listo', 'banda_g49',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000079', 'G79',  'General $79',  'otros', 0, 7900,
   'nuevo', 'listo', 'banda_g79',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000099', 'G99',  'General $99',  'otros', 0, 9900,
   'nuevo', 'listo', 'banda_g99',  0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000149', 'G149', 'General $149', 'otros', 0, 14900,
   'nuevo', 'listo', 'banda_g149', 0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'),
  ('00000000-0000-4000-8000-200000000199', 'G199', 'General $199', 'otros', 0, 19900,
   'nuevo', 'listo', 'banda_g199', 0, 1, 'S00', '', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')
on conflict (id) do nothing;
