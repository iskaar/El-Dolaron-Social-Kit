-- Intentos fallidos al aprobar con PIN en la caja (#837). Aditiva: una tabla nueva, sin tocar ninguna existente.
-- Aprobar una devolución de dinero o una cancelación con el PIN del dueño o de un supervisor cuenta sus fallos AQUÍ, por aprobador y por caja,
-- y no en usuarios.pin_fallos / pin_bloqueo (los de su propio acceso a la caja): quien se equivoque al aprobar no puede bloquear a un supervisor
-- fuera de su cuenta. Mismas reglas que el acceso: 5 intentos y bloqueo de 15 minutos, pero solo de esa caja para ese aprobador.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-082-intentos-aprobacion.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-082-intentos-aprobacion.sql

create table if not exists intentos_aprobacion (
  correo   text not null,                 -- el aprobador (dueño o supervisor)
  caja     text not null default '',      -- la caja donde se tecleó el PIN ('' si la terminal no eligió una)
  fallos   integer not null default 0,
  bloqueo  text not null default '',      -- ISO UTC; vacío = sin bloqueo
  primary key (correo, caja)
);
