-- Permiso por persona para editar inventario (Issue #441). Aditiva.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-050-editar-inventario.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-050-editar-inventario.sql
-- conteo_ajustes.motivo es texto sin CHECK: admite entrada y correccion.
alter table usuarios add column editar_inventario integer not null default 0 check (editar_inventario in (0, 1));
