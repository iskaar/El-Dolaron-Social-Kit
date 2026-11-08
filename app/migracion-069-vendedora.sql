-- Quien atendio la venta en piso (Issue #750, Fase 0 de #749). Aditiva.
-- `ventas.cajero` es quien cobra con su PIN; `vendedora` es la persona (correo de una cuenta activa con
-- rol cajero o capturista) a quien se le atribuye la venta. La caja la manda en el cuerpo de la venta y
-- el servidor la valida. Las ventas anteriores quedan con '' (sin atribuir).
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-069-vendedora.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-069-vendedora.sql
--
-- No es repetible: SQLite no tiene `add column if not exists`, asi que el `add column` falla si se corre
-- de nuevo (ya esta, no pasa nada). El indice es `if not exists`.

alter table ventas add column vendedora text not null default '';
create index if not exists ventas_vendedora on ventas (vendedora, registrado_en);
