-- Piezas nuevas por revisar antes de imprimir (#573). Aditiva; no toca existencias ni precios.
-- 1 = captura con foto (o UPC buscado en internet) que aún no se confirma en la tarjeta de revisión; la impresión automática de la PC la omite.
-- 0 = confirmada, guardada desde la tarjeta UPC, alta manual o pieza anterior: sale como siempre.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción (una sola sentencia, sin comentarios al final de línea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-059-por-revisar.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-059-por-revisar.sql
alter table productos add column por_revisar integer not null default 0 check (por_revisar in (0, 1));
