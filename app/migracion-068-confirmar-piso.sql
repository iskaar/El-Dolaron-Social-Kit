-- Confirmacion fisica en piso (Issue #724). Aditiva.
-- Regla de Isaac (4/11/2026): una pieza con menos de 3 existencias no se publica ni se reactiva
-- en Mercado Libre sin que alguien confirme en piso, escaneando su etiqueta en /inventario, que
-- existe (la XShot ED-003021 se vendio en ML y resulto en mal estado).
--
-- `existencia_confirmada_en` (ISO UTC) y `existencia_confirmada_por` (correo) los pone la ruta
-- POST /api/piezas/:id/confirmar-existencia. La confirmacion vale mientras no cambie el stock:
-- el trigger la borra en CUALQUIER UPDATE que cambie `stock` (venta en caja, ML, apartado,
-- devolucion, captura, fusion, ajuste), venga de la ruta que venga, asi no hay que recordar
-- tocar cada punto que mueve existencias ni una columna `stock_cambiado_en` que alguien olvide.
-- Un UPDATE que deja el mismo stock no la borra. Solo corre si hay confirmacion que borrar.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-068-confirmar-piso.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-068-confirmar-piso.sql
--
-- No es repetible del todo: SQLite no tiene `add column if not exists`, asi que los dos
-- `add column` fallan si se corre de nuevo (ya estan, no pasa nada). El trigger es `if not exists`.

alter table productos add column existencia_confirmada_en text;
alter table productos add column existencia_confirmada_por text;

create trigger if not exists existencia_confirmada_vigencia
after update of stock on productos
for each row when new.stock is not old.stock and old.existencia_confirmada_en is not null
begin
  update productos set existencia_confirmada_en = null, existencia_confirmada_por = null where id = new.id;
end;
