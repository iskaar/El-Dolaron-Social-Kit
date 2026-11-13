-- Espejo de captura por persona (Issue #775): la tarjeta actual de Capturar, compartida entre la PC y el celular de la misma cuenta. Aditiva.
-- Solo guarda un puntero a la tarjeta; nunca escribe inventario ni precios.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-073-espejo-captura.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-073-espejo-captura.sql
create table if not exists espejo_captura (
  correo text primary key,
  version integer not null,
  estado text not null default '{}',
  dispositivo text not null default '',
  actualizado_en text not null
);
