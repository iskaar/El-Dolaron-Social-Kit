-- Historial de cambios del Centro de Mando (/cm). Aditiva: tabla nueva para registrar qué variable cambió,
-- valor anterior y nuevo, quién la cambió y cuándo. El sistema sigue funcionando aunque la migración no haya corrido aún.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-092-cm-historial.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-092-cm-historial.sql
-- Puede repetirse sin error (`if not exists`).

create table if not exists config_historial (
  id           text primary key,
  clave        text not null,
  origen       text not null default 'config',   -- 'config' | 'nomina_config' | 'env_override'
  antes        text,                             -- null = sin valor / heredado
  despues      text,                             -- null = borrado / restaurado a herencia
  cambiado_por text not null,
  cambiado_en  text not null
);
create index if not exists config_historial_fecha on config_historial (cambiado_en desc);
create index if not exists config_historial_clave on config_historial (clave, cambiado_en desc);
