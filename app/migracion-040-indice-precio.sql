-- Indice para «Los mas buscados» del sitio (Issue #339): /api/catalogo/destacados?orden=precio
-- ordena lo vendible por precio. Sin el, cada visita al sitio lee las ~3,800 piezas (medido el
-- 16/10: rows_read 3774) y con trafico agota la cuota diaria de lecturas de D1 (5M).
--
-- Correr una vez (sandbox primero, luego prod). El codigo funciona antes y despues: sin el
-- indice la consulta solo lee de mas.
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-040-indice-precio.sql
--
-- Repetible: create index if not exists. Aditiva, no cambia datos.

create index if not exists productos_propietario_precio on productos (propietario, precio desc, creado_en desc, codigo);
