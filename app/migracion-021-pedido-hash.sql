-- Huella del pedido que mando la caja, para que un reintento del mismo folio sea
-- idempotente y un folio reutilizado con otro contenido se rechace (409).
-- Las ventas anteriores quedan en null: su reintento se acepta como antes.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-021-pedido-hash.sql

alter table ventas add column pedido_hash text;
