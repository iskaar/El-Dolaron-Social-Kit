-- Dos ventas concurrentes por la ultima pieza veian exito las dos: `max(0, stock - ?)`
-- se traga el conflicto en vez de avisarlo. Ahora SQLite mismo aborta cualquier UPDATE
-- que deje el stock en negativo, y como el descuento vive dentro del `.batch()` de la
-- venta, el ticket entero se deshace con el: no queda venta cobrada sin su pieza.
--
-- Correr una vez, despues de migracion-005:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-006-stock-no-negativo.sql
create trigger if not exists stock_no_negativo
before update of stock on productos
for each row when new.stock < 0
begin
  select raise(abort, 'stock insuficiente');
end;
