-- Descuentos con aprobacion del dueno (Issue #119). La solicitud vive en
-- `solicitudes` (tipo 'descuento'); la venta guarda cuanto se descuento y cual
-- solicitud lo autorizo. `ventas.total` ya queda con el descuento restado.
--
-- Numero 026: el 017 de la primera version lo tomo otro PR; main llego a la 025.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-026-descuentos.sql
--
-- SQLite no tiene `add column if not exists`: las dos columnas fallan si se
-- corre de nuevo (no pasa nada, ya estan). El indice si es repetible.

alter table ventas add column descuento integer not null default 0;   -- centavos
alter table ventas add column descuento_id text;                      -- solicitud aprobada

-- Una aprobacion sirve para una sola venta.
create unique index if not exists ventas_descuento_unico on ventas (descuento_id) where descuento_id is not null;
