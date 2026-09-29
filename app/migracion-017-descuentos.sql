-- Descuentos con aprobacion del dueno (Issue #119). La solicitud vive en
-- `solicitudes` (tipo 'descuento'); la venta guarda cuanto se descuento y cual
-- solicitud lo autorizo. `ventas.total` ya queda con el descuento restado.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-016-descuentos.sql

alter table ventas add column descuento integer not null default 0;   -- centavos
alter table ventas add column descuento_id text;                      -- solicitud aprobada

-- Una aprobacion sirve para una sola venta.
create unique index if not exists ventas_descuento_unico on ventas (descuento_id) where descuento_id is not null;
