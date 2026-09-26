-- Esquema del escaner de El Dolaron. Ver docs/ARQUITECTURA-ESCANER.md.
-- Todo el dinero se guarda en centavos MXN, enteros. Nada de flotantes en precios.

create table if not exists productos (
  id              text primary key,                    -- crypto.randomUUID() del cliente
  codigo          text unique,                         -- codigo de barras real o MK-000123
  nombre          text not null default '',
  categoria       text not null default '',            -- ropa|hogar|electronica|juguetes|otros
  precio_lista    integer not null default 0,          -- centavos MXN
  precio          integer not null default 0,          -- centavos MXN
  estado_fisico   text not null default 'nuevo',       -- nuevo|danado
  estado_analisis text not null default 'pendiente',   -- pendiente|listo|error
  destino         text not null default 'etiqueta',    -- etiqueta|banda_<prefijo><monto>, p.ej. banda_ju49
  stock           integer not null default 1,
  sin_inventario  integer not null default 0,          -- 1 = los bins, no descuentan
  semana_ingreso  text not null,                       -- 'S37'
  foto_key        text not null default '',            -- llave en R2
  creado_en       text not null,
  actualizado_en  text not null
);

create index if not exists productos_estado_analisis on productos (estado_analisis);

create table if not exists config (
  clave text primary key,
  valor text not null
);

-- Valores de arranque confirmados por Isaac (2026-09-11, bandas 2026-09-24).
-- Editables desde el admin. Porcentajes en enteros; limites y precios de
-- banda en centavos. Las siete bandas las comparten las dos familias
-- (ropa/general) -- ver docs/PLAN-ETIQUETAS-POR-BANDA.md.
insert into config (clave, valor) values
  ('pct_ropa',        '50'),
  ('pct_hogar',       '50'),
  ('pct_electronica', '50'),
  ('pct_juguetes',    '50'),
  ('pct_otros',       '50'),
  ('pct_danado',      '60'),
  ('limite_banda',    '20000'),
  ('banda_19',        '1900'),
  ('banda_29',        '2900'),
  ('banda_49',        '4900'),
  ('banda_79',        '7900'),
  ('banda_99',        '9900'),
  ('banda_149',       '14900'),
  ('banda_199',       '19900')
on conflict (clave) do nothing;

-- Familias de banda: cada una lleva sus siete productos de catalogo (ver
-- migracion-009-familias.sql y crearFamilia en worker.ts). El prefijo es el
-- de su codigo de barras impreso: R49, G49, JU49.
create table if not exists familias (
  clave     text primary key,           -- 'juguetes'
  nombre    text not null,              -- 'Juguetes'
  prefijo   text not null unique,       -- 'ju'
  creado_en text not null
);

-- Centro de cuentas (migracion-010-cuentas.sql, Issue #75).
create table if not exists usuarios (
  correo         text primary key,              -- en minusculas, el de Google
  nombre         text not null default '',
  roles          text not null default '',      -- separados por coma: dueno,cajero,capturista
  activo         integer not null default 1,
  creado_en      text not null,
  actualizado_en text not null
);

create table if not exists solicitudes (
  id            text primary key,
  tipo          text not null,                  -- acceso
  correo        text not null,
  nombre        text not null default '',
  justificacion text not null,
  datos         text not null default '{}',
  estado        text not null default 'pendiente',  -- pendiente|aprobada|rechazada
  creado_en     text not null,
  resuelto_en   text,
  resuelto_por  text
);

create index if not exists solicitudes_pendientes on solicitudes (estado, creado_en);
