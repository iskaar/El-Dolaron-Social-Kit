-- Talla de ropa de cada pieza (Issue #218). Adulto: "M"; nino: "Niño 6 años / S"
-- (la talla de nino es opcional). La lista permitida vive en public/tallas.js.
-- Nula = no es ropa; las piezas de antes de este cambio quedan nulas.
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-027-talla.sql

alter table productos add column talla text;
