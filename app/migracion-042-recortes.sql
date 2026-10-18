-- Recortes automáticos de fotos para el catálogo público (Issue #345).
-- Correr una vez, antes del deploy (sandbox primero, luego producción):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-042-recortes.sql
-- Va después de 041 (ropa-ia). Independiente de ella.
alter table productos add column recorte_estado text check (recorte_estado is null or recorte_estado in ('listo','error','original'));
alter table productos add column recorte_fecha text;
create index productos_recortes_pendientes on productos (creado_en) where recorte_estado is null and destino='etiqueta' and sin_inventario=0 and estado_analisis='listo' and stock>0 and estado_fisico<>'danado' and codigo like 'ED-%' and precio>0 and foto_key<>'' and trim(nombre)<>'';
create index productos_recortes_recientes on productos (recorte_fecha desc) where recorte_estado in ('listo','error');
