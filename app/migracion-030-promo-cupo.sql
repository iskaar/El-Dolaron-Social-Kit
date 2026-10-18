-- Promo de inauguracion con tope (Issue #250): «a las primeras 100 personas».
-- `descuento` ya trae la promo sumada; esta columna la separa para contar cuantos
-- tickets la recibieron (PROMO_CUPO). Las ventas anteriores quedan en 0: la promo
-- empieza el 9/10, despues de esta migracion.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-030-promo-cupo.sql
--
-- Falla si se corre de nuevo (la columna ya existe): no pasa nada.

alter table ventas add column promo integer not null default 0;   -- centavos
