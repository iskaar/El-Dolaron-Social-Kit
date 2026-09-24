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
  destino         text not null default 'etiqueta',    -- etiqueta|banda_r19..banda_g199
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
