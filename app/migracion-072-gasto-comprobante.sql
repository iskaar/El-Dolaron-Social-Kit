-- Comprobante de un gasto (Issue #770). Aditiva.
-- `gastos.comprobante_key` es la llave en R2 (FOTOS, gastos/<id>/<uuid>.<ext>) del archivo adjunto: foto, PDF o XML
-- (CFDI). NULL = sin comprobante. La API nunca devuelve la llave, solo `con_comprobante`.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-072-gasto-comprobante.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-072-gasto-comprobante.sql
--
-- No es repetible: SQLite no tiene `add column if not exists`, asi que si se corre de nuevo falla porque la
-- columna ya esta (no pasa nada).

alter table gastos add column comprobante_key text;
