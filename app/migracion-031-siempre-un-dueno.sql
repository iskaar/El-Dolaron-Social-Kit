-- Nunca sin dueno activo (Issue #253, auditoria #233 punto 5). La revision en
-- cuentas.ts corria ANTES de escribir: dos dueños quitandose el rol a la vez
-- pasaban los dos y la tienda quedaba sin nadie que apruebe cuentas. El trigger
-- corre dentro de la misma escritura (y del batch): no hay ventana.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-031-siempre-un-dueno.sql
--
-- Repetible. Solo se dispara si la fila cambiada ERA dueno activo: una base sin
-- dueños (recien creada) puede seguir dando de alta cuentas.

create trigger if not exists siempre_un_dueno
after update of roles, activo on usuarios
for each row when old.activo = 1 and (',' || old.roles || ',') like '%,dueno,%'
  and not exists (select 1 from usuarios where activo = 1 and (',' || roles || ',') like '%,dueno,%')
begin
  select raise(abort, 'sin_dueno');
end;
