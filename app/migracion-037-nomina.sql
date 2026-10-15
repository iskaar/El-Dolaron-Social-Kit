-- Nómina interna (Issue #326). Isaac ejecuta esta migración en sandbox y producción antes del deploy.
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-037-nomina.sql
-- Esta migración aún no se ha ejecutado: define el modelo nuevo desde cero.
-- `retiros.tipo` admite 'nomina'; el corte resta esos retiros de la caja.
-- Convención: devengo, adelanto y bono positivos; pago, abono y ajuste negativos.
alter table cortes add column nomina integer not null default 0;

create table empleados (
  id text primary key,
  nombre text not null,
  periodo text not null check (periodo in ('diario', 'quincenal')),
  pago_dia integer not null check (pago_dia > 0),
  dias text not null default '[]',
  hora_entrada text,
  pin_hash text not null default '',
  pin_fallos integer not null default 0,
  pin_bloqueo text not null default '',   -- ISO; tras 5 fallos, 15 min (checador)
  activo integer not null default 1 check (activo in (0, 1)),
  creado_en text not null,
  check (hora_entrada is null or hora_entrada glob '[01][0-9]:[0-5][0-9]'
    or hora_entrada glob '2[0-3]:[0-5][0-9]')
);

create table asistencias (
  empleado_id text not null references empleados(id),
  fecha text not null check (length(fecha) = 10),
  entrada text not null,
  origen text not null check (origen in ('pin', 'manual')),
  primary key (empleado_id, fecha)
);

create table nomina_config (
  id integer primary key check (id = 1),
  checador_activo integer not null default 0 check (checador_activo in (0, 1)),
  bono_centavos integer not null default 0 check (bono_centavos >= 0),
  tolerancia_minutos integer not null default 0 check (tolerancia_minutos between 0 and 240),
  retardos_permitidos integer not null default 0 check (retardos_permitidos between 0 and 31),
  faltas_permitidas integer not null default 0 check (faltas_permitidas between 0 and 31)
);
insert into nomina_config (id) values (1);

create table nomina_movimientos (
  id text primary key,
  empleado_id text not null references empleados(id),
  fecha text not null check (length(fecha) = 10),
  tipo text not null check (tipo in ('devengo', 'pago', 'adelanto', 'abono', 'ajuste', 'bono')),
  importe integer not null check (importe != 0),
  nota text not null default '',
  origen text check (origen in ('caja', 'fuera')),
  retiro_id text,
  creado_por text not null,
  creado_en text not null
);
create index nomina_movimientos_empleado_fecha on nomina_movimientos (empleado_id, fecha);
