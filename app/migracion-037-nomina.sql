-- Nomina interna (Issue #326, fase 2). Ejecutar sandbox y luego prod ANTES del deploy:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-037-nomina.sql
-- `retiros.tipo` no tiene CHECK en la migracion 013; admite 'nomina' sin reconstruccion.
-- Importes en centavos: devengo y adelanto positivos; falta, pago y abono negativos.
alter table cortes add column nomina integer not null default 0;

create table empleados (
  id text primary key,
  nombre text not null,
  periodo text not null check (periodo in ('diario', 'quincenal')),
  sueldo integer not null check (sueldo > 0),
  activo integer not null default 1 check (activo in (0, 1)),
  creado_en text not null
);

create table nomina_movimientos (
  id text primary key,
  empleado_id text not null references empleados(id),
  fecha text not null check (length(fecha) = 10),
  tipo text not null check (tipo in ('devengo', 'falta', 'pago', 'adelanto', 'abono')),
  importe integer not null check (importe != 0),
  nota text not null default '',
  origen text check (origen in ('caja', 'fuera')),
  retiro_id text,
  creado_por text not null,
  creado_en text not null
);
create index nomina_movimientos_empleado_fecha on nomina_movimientos (empleado_id, fecha);
