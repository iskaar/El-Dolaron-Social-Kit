-- Cada cajero tiene su caja (Issue #105). Entre en la computadora que entre,
-- sus ventas, gastos, retiros y cortes van a su caja; usar el cajon de la otra
-- computadora es bajo su responsabilidad. '' = sin caja asignada: se usa la
-- que se eligio en esa computadora (el dueno, por ejemplo).
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (y despues de la 013):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-014-caja-del-cajero.sql

alter table usuarios add column caja text not null default '';
