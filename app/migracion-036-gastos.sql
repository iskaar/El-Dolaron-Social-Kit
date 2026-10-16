-- Gastos con categoría (Issue #326, fase 1): el gasto de caja conserva su
-- retiro para el corte; los gastos pagados fuera no afectan efectivo de caja.
--
-- Correr una vez, ANTES de desplegar el código que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-036-gastos.sql
--
-- Aditiva. Falla si se corre de nuevo al agregar categoria a retiros.

alter table retiros add column categoria text not null default '';

create table if not exists gastos (
  id         text primary key,
  fecha      text not null,                         -- YYYY-MM-DD, hora de México
  categoria  text not null,
  importe    integer not null check (importe > 0), -- centavos MXN
  nota       text not null default '',
  origen     text not null check (origen in ('caja', 'fuera')),
  retiro_id  text,
  creado_por text not null,
  creado_en  text not null
);

create index if not exists gastos_fecha on gastos (fecha);
