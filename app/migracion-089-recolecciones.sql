-- Recolección del efectivo de los cortes por tienda (Issue #909, fase 1 de #908). Aditiva: dos tablas nuevas y una clave de `config`;
-- no toca ninguna fila ni columna existente (cortes y /api/cortes quedan igual).
-- Una recolección junta los cortes de UNA tienda cuyo efectivo (`entregado`) recoge gerencia: guarda quién recibió, quién entregó (firma con PIN;
-- '' = sin firma), cuánto se esperaba (suma de `entregado`), cuánto se contó y la diferencia. Todo en centavos enteros.
-- `recolecciones_cortes.corte_id` es la llave primaria: un corte NO puede estar en dos recolecciones, lo impide la base y no solo el código.
-- `recolecciones_desde` (ISO UTC, en `config`): los cortes con `hasta` anterior no cuentan como pendientes. Queda en el momento de correr esta
-- migración; gerencia la cambia en /dinero.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-089-recolecciones.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-089-recolecciones.sql
-- Volver a correrla es inofensivo (create if not exists, config con on conflict do nothing), pero NO mueve `recolecciones_desde`.

create table if not exists recolecciones (
  id          text primary key,                  -- UUID de la pantalla: reenviar no duplica
  tienda      text not null,                     -- clave de TIENDAS
  recibio     text not null,                     -- correo de la sesión de gerencia
  entrego     text not null default '',          -- correo de quien firmó con su PIN; '' = sin firma
  esperado    integer not null check (esperado > 0),
  contado     integer not null check (contado >= 0),
  diferencia  integer not null,                  -- contado - esperado
  nota        text not null default '',
  creado_en   text not null,
  check (diferencia = contado - esperado),
  check (diferencia = 0 or nota != '')           -- una diferencia sin explicar no se guarda, ni aunque cambie lo pendiente a media petición
);
create index if not exists recolecciones_creado on recolecciones (creado_en);

create table if not exists recolecciones_cortes (
  corte_id        text primary key,              -- un corte, una recolección
  recoleccion_id  text not null
);
create index if not exists recolecciones_cortes_recoleccion on recolecciones_cortes (recoleccion_id);

insert into config (clave, valor) values ('recolecciones_desde', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  on conflict (clave) do nothing;
