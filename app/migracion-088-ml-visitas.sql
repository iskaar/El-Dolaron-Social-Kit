-- Visitas por publicacion de Mercado Libre (Issue #637): el cron guarda una vez al dia las visitas de los
-- ultimos 7 dias de cada publicacion activa o pausada (solo lee de ML), para medir con datos y no a ojo cuando
-- una publicacion necesita otra foto, otro precio o una promocion. Tambien guarda `sub_status` y `tags` que ML
-- reporta de cada articulo (pausada, en revision, miniatura de mala calidad...) para explicar visitas bajas.
-- Las ventas de 7 dias no necesitan columna: salen de `ml_ventas`.
--
-- Correr una vez, ANTES de desplegar el codigo que las usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-088-ml-visitas.sql
--
-- Aditiva: columnas nuevas y nulas, nada se borra ni se reescribe. NO repetirla: SQLite no tiene
-- `add column if not exists`, y una segunda corrida falla con «duplicate column name» sin danar nada.
-- visitas_7d null = aun sin dato (distinto de 0 visitas). visitas_actualizado_en = ISO UTC de la ultima lectura buena.
-- sub_status: textos de ML separados por coma; tags: arreglo JSON.
alter table ml_publicaciones add column visitas_7d integer;
alter table ml_publicaciones add column visitas_actualizado_en text;
alter table ml_publicaciones add column sub_status text;
alter table ml_publicaciones add column tags text;
-- visitas_intento_en: guardia de «una lectura por dia»; se marca en cada intento (bueno o malo) para que una publicacion
-- que ML no contesta no se repita cada 15 minutos ni tape a las demas. '' = nunca intentada.
alter table ml_publicaciones add column visitas_intento_en text not null default '';
