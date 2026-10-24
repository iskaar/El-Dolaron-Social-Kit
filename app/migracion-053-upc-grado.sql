-- UPC por propietario y grado, incluidas piezas sin foto o pendientes (#452). Sin unicidad histórica.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-053-upc-grado.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-053-upc-grado.sql
create index if not exists productos_upc_grado on productos (propietario, ltrim(upc, '0'), estado_fisico, coalesce(codigo, ''))
  where sin_inventario = 0 and estado_analisis <> 'descartado' and upc is not null and upc <> '';
