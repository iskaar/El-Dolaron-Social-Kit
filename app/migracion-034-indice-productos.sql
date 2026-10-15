-- Indice para la cola de captura y de impresion (Issue #308).
-- /api/borradores filtra por propietario y por creado_en; sin este indice cada
-- consulta (la pantalla de impresion la repite cada 2 s) lee casi toda la tabla
-- productos y agota la cuota diaria de lecturas de D1.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-034-indice-productos.sql
--
-- Repetible: create index if not exists. Aditiva, no cambia datos.

create index if not exists productos_propietario_creado on productos (propietario, creado_en);
