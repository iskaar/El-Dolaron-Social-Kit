-- Origen de cada renglón del manifiesto (Issue #965). Aditiva: una columna nueva con valor por defecto.
-- 'hoja' = viene de la hoja del proveedor (todo lo que ya existe); 'upcitemdb' = lo consultó el escáner al ver un UPC
-- que la hoja no trae. La hoja manda: tools/importar_manifiesto.py reemplaza el renglón y lo marca 'hoja'.
--
-- Isaac ejecuta UNA vez, ANTES del deploy (sandbox primero, luego producción):
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-093-manifiesto-origen.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-093-manifiesto-origen.sql
-- No repetir (SQLite no tiene `add column if not exists`). Sin la migración el escáner sigue como hoy:
-- la consulta falla al guardar y la tarjeta pide foto. El importador sí la requiere (lee y escribe `origen`).

alter table manifiesto add column origen text not null default 'hoja';
