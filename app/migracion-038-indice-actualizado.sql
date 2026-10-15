-- Indice para que la caja pida solo lo que cambio del catalogo (/api/catalogo?desde=).
-- Sin el, cada consulta lee las ~3000 piezas y agota la cuota diaria de lecturas de D1 (15/10).
--
-- Correr una vez (sandbox primero, luego prod). El codigo funciona antes y despues: sin el
-- indice la consulta solo lee de mas.
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-038-indice-actualizado.sql
--
-- Repetible: create index if not exists. Aditiva, no cambia datos.
-- Independiente de 036 (gastos) y 037 (nomina): se puede correr antes que ellas.

create index if not exists productos_actualizado on productos (actualizado_en);
