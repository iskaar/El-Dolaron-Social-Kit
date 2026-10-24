-- Centro de avisos (Issue #429): cada venta de Mercado Libre queda a la vista en
-- /avisos hasta que alguien la atiende. Aditiva; no cambia stock.
-- (Antes era migracion-046-avisos.sql; se renumero sin cambiar su contenido.)
--
-- Correr una vez, en sandbox y luego en prod, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-058-avisos.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-058-avisos.sql
--
-- NO es re-ejecutable: SQLite no tiene `add column if not exists`. Si ya corrio (tambien
-- con el nombre viejo 046), la segunda vez falla con «duplicate column name: atendida_en»
-- y no cambia nada; ese error significa que ya esta aplicada.
alter table ml_ventas add column atendida_en text not null default '';
alter table ml_ventas add column atendida_por text not null default '';
