-- Corte de caja (Issue #100): cada venta sabe en que caja se cobro y quien la
-- cobro; el corte junta todo lo de una caja desde su corte anterior.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-013-cortes.sql

alter table ventas add column caja text not null default '';            -- «Caja 1», de la computadora que cobro
alter table ventas add column cajero text not null default '';          -- correo de Access de quien cobro
alter table ventas add column corte_id text;                            -- el corte que conto su dinero
alter table ventas add column cancelada_caja text not null default '';  -- donde se devolvio el dinero
alter table ventas add column corte_cancelacion_id text;                -- el corte que conto la devolucion

create index if not exists ventas_caja_corte on ventas (caja, corte_id);
create index if not exists ventas_cancelacion_corte on ventas (cancelada_caja, corte_cancelacion_id);

alter table cajon_aperturas add column caja text not null default '';

-- Efectivo que sale de la caja a media jornada: retiros (a la caja fuerte, al
-- banco) y gastos (agua, limpieza...). Gastos de hasta $100 los registra el
-- cajero sin aprobacion; los mayores, el dueno.
create table if not exists retiros (
  id        text primary key,               -- crypto.randomUUID() de la caja
  tipo      text not null default 'retiro', -- retiro|gasto
  caja      text not null,
  cajero    text not null,
  importe   integer not null,               -- centavos
  motivo    text not null,                  -- motivo del retiro o concepto del gasto
  corte_id  text,
  creado_en text not null
);

create index if not exists retiros_caja_corte on retiros (caja, corte_id);

-- Todo en centavos. Las cifras se calculan en el servidor en el mismo batch
-- que marca las ventas; la caja solo manda lo contado.
create table if not exists cortes (
  id                    text primary key,   -- crypto.randomUUID() de la caja: reenviar no duplica
  caja                  text not null,
  cajero                text not null,
  desde                 text,               -- hasta del corte anterior de esta caja; null en el primero
  hasta                 text not null,      -- hora del servidor
  tickets               integer not null,   -- ventas cobradas en esta caja en el periodo
  fondo_inicial         integer not null,
  efectivo_ventas       integer not null,   -- cobrado en efectivo (sin la parte en Dolarones)
  efectivo_devoluciones integer not null,   -- devuelto por cancelaciones hechas en esta caja
  retiros               integer not null,
  gastos                integer not null default 0,
  efectivo_esperado     integer not null,   -- fondo + ventas - devoluciones - retiros - gastos
  efectivo_contado      integer not null,
  diferencia            integer not null,   -- contado - esperado: + sobra, - falta
  tarjeta_sistema       integer not null,   -- neto de devoluciones
  tarjeta_terminal      integer not null,   -- lo que dice el cierre de la terminal
  transferencias        integer not null,
  dolarones             integer not null,
  fondo_siguiente       integer not null,   -- lo que se queda en la caja
  entregado             integer not null,   -- contado - fondo_siguiente
  conteo                text not null default '{}',   -- sin uso: el cajero escribe solo el total
  notas                 text not null default '',
  creado_en             text not null
);

create index if not exists cortes_caja on cortes (caja, hasta);

-- Fondo fijo por caja; lo demas se entrega. Editable en el admin.
insert into config (clave, valor) values ('fondo_caja', '50000') on conflict (clave) do nothing;
