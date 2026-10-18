-- Conteo nocturno de piezas de alto valor (Issue #219, tras un robo). Cada
-- ajuste de existencias por faltante deja rastro: quien, cuando, antes, despues
-- y el motivo (robo, merma o error de captura). El conteo en si no se guarda:
-- solo los ajustes. Las existencias siguen en `productos`, nada mas.
--
-- Correr una vez, despues de migracion-026 (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-028-conteo.sql
--
-- `create ... if not exists`: es repetible sin efectos.

create table if not exists conteo_ajustes (
  id           text primary key,
  producto_id  text not null,
  codigo       text not null default '',
  nombre       text not null default '',
  motivo       text not null,                 -- robo|merma|error de captura
  cantidad     integer not null,              -- piezas que salen del inventario
  antes        integer not null,              -- existencia antes del ajuste
  despues      integer not null,              -- existencia despues (nunca negativa)
  ajustado_por text not null,                 -- correo de la cuenta que aplico el ajuste
  ajustado_en  text not null
);

create index if not exists conteo_ajustes_fecha on conteo_ajustes (ajustado_en);
