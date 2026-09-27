-- Aperturas del cajon sin venta (Issue #97): el boton «Abrir cajon» de la caja
-- deja quien y cuando, igual que una cancelacion deja motivo y correo.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-012-cajon.sql

create table if not exists cajon_aperturas (
  id            text primary key,     -- crypto.randomUUID() de la caja: reenviar no duplica
  abierto_por   text not null,        -- correo de Access de quien la hizo
  abierto_en    text not null,        -- hora en la caja; puede llegar despues si no habia red
  registrado_en text not null
);

create index if not exists cajon_abierto on cajon_aperturas (abierto_en);
