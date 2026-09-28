-- PIN del cajero (Issue #112). La computadora de caja entra a Access con la
-- cuenta de la tienda (rol `computadora`); cada cajero se identifica con su
-- PIN de 6 digitos y lo que hace queda a su nombre.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-015-pin-cajero.sql

alter table usuarios add column pin_hash text not null default '';     -- PBKDF2, como el de socios
alter table usuarios add column pin_sal text not null default '';
alter table usuarios add column pin_fallos integer not null default 0;
alter table usuarios add column pin_bloqueo text not null default '';  -- ISO; bloqueado hasta entonces

-- Quien esta en turno en cada computadora. Se guarda el SHA-256 del token, no el token.
create table if not exists sesiones_cajero (
  token_hash text primary key,
  correo     text not null,
  creado_en  text not null,
  expira_en  text not null
);
