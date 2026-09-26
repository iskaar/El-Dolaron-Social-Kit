-- Centro de cuentas (Issue #75). Cloudflare Access dice QUIEN es (Google); esta
-- tabla dice si puede entrar y QUE puede hacer. Sin fila activa, la persona
-- solo ve la pantalla para pedir acceso.
--
-- Correr una vez:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-010-cuentas.sql
--
-- Y ANTES de desplegar el codigo que la usa, dar de alta al dueno (el correo no
-- va aqui: el repositorio es publico). Sin esto nadie puede aprobar a nadie:
--   npx wrangler d1 execute el-dolaron --remote --command "insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('<correo>', '<nombre>', 'dueno', 1, datetime('now'), datetime('now'))"

create table if not exists usuarios (
  correo         text primary key,              -- en minusculas, el de Google
  nombre         text not null default '',
  roles          text not null default '',      -- separados por coma: dueno,cajero,capturista
  activo         integer not null default 1,    -- 0 = no entra, sin borrar su historial
  creado_en      text not null,
  actualizado_en text not null
);

-- Todo lo que alguien pide y el dueno aprueba o rechaza. Hoy solo 'acceso';
-- las fases 2 y 3 del Issue #75 agregan cancelar venta y cambiar precio.
create table if not exists solicitudes (
  id            text primary key,
  tipo          text not null,                  -- acceso
  correo        text not null,                  -- quien la pide
  nombre        text not null default '',
  justificacion text not null,
  datos         text not null default '{}',     -- JSON, segun el tipo
  estado        text not null default 'pendiente',  -- pendiente|aprobada|rechazada
  creado_en     text not null,
  resuelto_en   text,
  resuelto_por  text
);

create index if not exists solicitudes_pendientes on solicitudes (estado, creado_en);
