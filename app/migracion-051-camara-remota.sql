-- Buzón de cámara remota por persona (Issue #444). Aditiva.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-051-camara-remota.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-051-camara-remota.sql
create table if not exists camara_remota (
  correo text primary key,
  id text not null,
  tipo text not null check (tipo in ('foto_pieza', 'pieza_nueva')),
  pieza_id text not null,
  params text not null default '{}',
  titulo text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente', 'tomada', 'lista', 'cancelada')),
  telefono text not null default '',
  motivo text not null default '',
  creado_en text not null,
  vence_en text not null,
  tomada_en text not null default '',
  lista_en text not null default ''
);
