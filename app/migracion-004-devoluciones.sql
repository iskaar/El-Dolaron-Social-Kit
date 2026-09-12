-- Cancelar una venta ya cobrada: devoluciones y errores de cajera.
-- La venta no se borra. Se marca, para que el corte del dia siga explicando
-- todo lo que paso en la caja, incluido lo que se deshizo.
--
-- Correr una vez:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-004-devoluciones.sql
alter table ventas add column cancelada integer not null default 0;
alter table ventas add column cancelada_en text not null default '';
