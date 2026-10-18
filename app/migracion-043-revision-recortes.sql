-- Revisión de recortes automáticos (Issue #347).
-- Correr una vez, antes del deploy (sandbox primero, luego producción):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-043-revision-recortes.sql
-- Va después de 042 (recortes). Independiente de otras migraciones.
alter table productos add column recorte_revision text;
create index productos_recortes_por_revisar on productos (recorte_fecha) where recorte_estado='listo' and recorte_revision is null;
