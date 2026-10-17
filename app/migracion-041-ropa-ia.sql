-- Analisis por lotes de prendas en cola separada de las etiquetas (Issue #340).
-- Correr una vez, antes del deploy (sandbox primero, luego produccion):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-041-ropa-ia.sql
-- Va despues de 040 (indice por precio, PR #341). Independiente de ella.
alter table productos add column ropa_ia_estado text check (ropa_ia_estado is null or ropa_ia_estado in ('aplicado','revisar','aceptado','descartado','error'));
alter table productos add column ropa_ia_sugerencia text;
alter table productos add column ropa_ia_fecha text;
create index productos_ropa_ia_pendiente on productos (creado_en) where ropa_ia_estado is null and categoria='ropa' and nombre='Ropa' and foto_key<>'' and stock>0;
create index productos_ropa_marcas on productos (marca) where categoria='ropa' and marca<>'';
