-- Cuenta de la app de cada empleado (Issue #751, Fase 1 de #749). Aditiva.
-- `empleados.correo` liga a la persona de nomina con su cuenta (`usuarios.correo`, rol cajero o capturista):
-- asi /reportes une ventas atendidas, socios y piezas capturadas con sus dias trabajados (`asistencias`)
-- para repartir el bono semanal de la tienda. '' = sin cuenta ligada (no entra al reparto).
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-070-empleado-correo.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-070-empleado-correo.sql
--
-- No es repetible: SQLite no tiene `add column if not exists`, asi que el `add column` falla si se corre
-- de nuevo (ya esta, no pasa nada). El indice es `if not exists`.

alter table empleados add column correo text not null default '';
-- Una cuenta no puede estar ligada a dos empleados; los '' (sin ligar) no cuentan.
create unique index if not exists empleados_correo on empleados (correo) where correo <> '';
