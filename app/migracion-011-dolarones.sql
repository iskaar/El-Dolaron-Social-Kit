-- Dolarones v1 (Issue #81). Reglas en docs/RECOMPENSAS-DOLARONES.md.
-- 1 Dolaron = $1 MXN y, como todo el dinero de la app, se guarda en centavos
-- enteros: 1 D = 100.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-011-dolarones.sql
--
-- El numero de socio decide el regalo de apertura (#1 a #100): las altas de
-- prueba se hacen en local, nunca en la base de la tienda.

create table if not exists clientes (
  id             text primary key,               -- crypto.randomUUID() de la pantalla de alta
  numero         integer not null unique,        -- numero de socio, en orden de alta
  nombre         text not null,
  telefono       text not null unique,           -- 10 digitos; con el se busca en la caja
  correo         text not null default '',
  pin_hash       text not null,                  -- PBKDF2-SHA256, nunca el PIN
  pin_sal        text not null,
  pin_fallos     integer not null default 0,
  pin_bloqueo    text not null default '',       -- ISO; vacio = sin bloqueo
  bases_version  text not null,                  -- version de bases y aviso que acepto
  registrado_por text not null,                  -- correo de Access de quien hizo el alta
  creado_en      text not null
);

-- El saldo vive en lotes: cada uno con su propio vencimiento (regalo 30 dias,
-- compra 12 meses). Gastar descuenta `restante` del lote que vence primero.
create table if not exists dolarones_lotes (
  id               text primary key,
  cliente_id       text not null references clientes(id),
  origen           text not null,                -- regalo|compra
  venta_id         text,                         -- la compra que lo gano
  importe          integer not null,             -- centavos de D
  restante         integer not null,
  disponible_desde text not null,                -- ISO UTC
  vence_en         text not null,                -- ISO UTC
  creado_en        text not null
);

create index if not exists lotes_cliente on dolarones_lotes (cliente_id, vence_en);
-- Una compra gana una sola vez, aunque la venta se reenvie.
create unique index if not exists lotes_venta on dolarones_lotes (venta_id) where venta_id is not null;

-- Igual que stock_no_negativo (migracion 006): si dos cajas gastan el mismo
-- saldo a la vez, la segunda aborta su batch completo en vez de dejarlo en
-- negativo. El canje manda -1 a proposito si el lote ya vencio o aun no esta
-- disponible (ver dolarones.ts), para que este trigger lo rechace tambien.
create trigger if not exists lote_no_negativo
before update of restante on dolarones_lotes
for each row when new.restante < 0 or new.restante > new.importe
begin
  select raise(abort, 'saldo insuficiente');
end;

-- Bitacora: nunca se edita ni se borra. + entra al saldo, - sale.
create table if not exists dolarones_movimientos (
  id         integer primary key autoincrement,
  cliente_id text not null,
  lote_id    text not null,
  venta_id   text,
  tipo       text not null,                      -- regalo|compra|canje|reverso_canje|reverso_compra
  importe    integer not null,
  autor      text not null,
  creado_en  text not null
);

create index if not exists movimientos_venta on dolarones_movimientos (venta_id);

alter table ventas add column cliente_id text;
-- Parte del total pagada con Dolarones. Lo cobrado en dinero es total - dolarones.
alter table ventas add column dolarones integer not null default 0;

-- Cancelar dos veces devolveria dos veces existencias y Dolarones: la segunda
-- aborta todo su batch.
create trigger if not exists venta_cancelada_una_vez
before update of cancelada on ventas
for each row when old.cancelada = 1
begin
  select raise(abort, 'venta ya cancelada');
end;
