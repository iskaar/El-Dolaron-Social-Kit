-- Tiendas y cajas por tienda (Issue #794, parte 1 de 3 de #793). Aditiva: dos columnas con valor por omisión; no toca existencias ni productos.
-- usuarios.tienda: clave de la tienda de la cuenta ('soledad', 'salk', 'romero'); '' = sin tienda (cuenta como Soledad, salvo la computadora de caja: esa no cobra sin tienda).
-- ventas.tienda: la tienda donde se cobró, congelada como el precio; el historial es de Soledad.
-- Las computadoras de caja que ya existen y están activas quedan en Soledad: nada cambia hoy.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-076-tiendas.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-076-tiendas.sql
alter table usuarios add column tienda text not null default '';
alter table ventas add column tienda text not null default 'soledad';
update usuarios set tienda = 'soledad' where activo = 1 and (',' || replace(roles, ' ', '') || ',') like '%,computadora,%';
