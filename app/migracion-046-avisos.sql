-- Centro de avisos (Issue #429): cada venta de Mercado Libre queda a la vista en
-- /avisos hasta que alguien la atiende. Aditiva; no cambia stock.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-046-avisos.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-046-avisos.sql
alter table ml_ventas add column atendida_en text not null default '';
alter table ml_ventas add column atendida_por text not null default '';
