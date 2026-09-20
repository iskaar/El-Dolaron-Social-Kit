-- Cancelar una venta devolvia la existencia y no contaba en el corte, pero no
-- dejaba huella de quien cancelo ni por que. Con dinero real de por medio, una
-- cancelacion falsa (cobrar de verdad y "cancelar" para quedarse el efectivo)
-- no se distinguia de una legitima.
--
-- Correr una vez, despues de migracion-006:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-007-cancelacion-rastreo.sql
alter table ventas add column cancelada_por text not null default '';
alter table ventas add column motivo_cancelacion text not null default '';
