-- Retos y logros con credito en Dolarones (Issue #752, Fase 2 de #749). Aditiva.
-- `empleados.cliente_id` liga a la empleada con su cuenta de socio (`clientes.id`): se crea al primer logro con
-- credito y alli caen los Dolarones (lotes origen 'reto'). '' = todavia sin cuenta.
-- `retos_logros` es el libro de logros: uno por (correo, logro, ref), asi el cron diario puede correr dos veces sin
-- pagar doble. `d` son Dolarones enteros (0 = ya se llego al tope mensual `config.reto_d_tope_mes`, sin credito).
-- `dolarones_lotes.origen` no tiene CHECK: 'reto' no necesita cambiarlo.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-071-retos.sql
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-071-retos.sql
--
-- No es repetible: SQLite no tiene `add column if not exists`, asi que el `add column` falla si se corre
-- de nuevo (ya esta, no pasa nada). La tabla y el indice son `if not exists`.

alter table empleados add column cliente_id text not null default '';

create table if not exists retos_logros (
  id        text primary key,
  correo    text not null,              -- cuenta de la empleada (empleados.correo)
  logro     text not null,              -- antiguedad|desatorar|racha|socio|apartado
  ref       text not null,              -- linea de venta, cliente, pedido o ultimo dia de la racha
  d         integer not null,           -- Dolarones enteros; 0 = tope mensual
  creado_en text not null,
  unique (correo, logro, ref)
);
create index if not exists retos_logros_correo on retos_logros (correo, creado_en);
