-- Pieza que el cliente trae en la mano aunque el sistema marque existencia 0 (Issue #832). Aditiva: tres columnas nuevas en `conteo_ajustes`.
-- El ajuste auditado de «+faltante» que hace la venta (motivo `hallada_en_caja`) vive en la misma tabla de siempre: asi aparece solo en el historial
-- de la pieza, en la vista `movimientos_existencia` y en el rastro del dueno. `cantidad` es el faltante que se subio (positivo) y `antes`/`despues`
-- la existencia de la tienda alrededor de ese ajuste (antes de bajar la pieza vendida). Ningun lector actual cambia: los reportes filtran por
-- motivo (robo, merma, error de captura, entrada) y este es otro.
--   venta_id  folio de la venta que hizo el ajuste ('' en todos los demas); el `id` del renglon es `<venta>:<pieza>`, asi un reintento no ajusta dos veces
--   caja      la caja donde se cobro
--   razon     lo que escogio el cajero con un toque: otra_etiqueta | devuelta_o_apartada | no_se
-- No es repetible: SQLite no tiene `add column if not exists` (si ya estan, el error es inofensivo).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-081-hallada-en-caja.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-081-hallada-en-caja.sql

alter table conteo_ajustes add column venta_id text not null default '';
alter table conteo_ajustes add column caja text not null default '';
alter table conteo_ajustes add column razon text not null default '';
