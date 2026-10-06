-- Cancelar piezas sueltas de un ticket ya cobrado (Issue #138), no solo el
-- ticket completo. La venta y sus lineas no se tocan: cada pieza devuelta
-- queda como un renglon de `devoluciones`, con quien, por que, cuanto dinero
-- salio y de que caja, para que el corte de esa caja lo reste.
--
-- Numero 020: las migraciones 016 a 019 estan tomadas por PRs abiertos.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-020-devoluciones-por-pieza.sql

alter table venta_lineas add column cancelada_cantidad integer not null default 0;

-- Lo ya devuelto de este ticket por piezas canceladas. «Dinero primero»
-- (Isaac, 30/09): la pieza se devuelve en dinero hasta lo que el cliente pago
-- en dinero; solo el excedente regresa como Dolarones.
alter table ventas add column devuelto integer not null default 0;              -- centavos, dinero
alter table ventas add column dolarones_devueltos integer not null default 0;   -- centavos de D

-- Candado optimista: todo lo que cambia un ticket ya cobrado (cancelarlo o
-- cancelar una pieza) sube la revision en uno sobre la que leyo. Si otra
-- cancelacion del mismo ticket se adelanto, la revision ya no cuadra y el
-- batch completo se deshace: nada se devuelve dos veces.
alter table ventas add column revision integer not null default 0;

create trigger if not exists venta_revision
before update of revision on ventas
for each row when new.revision != old.revision + 1
begin
  select raise(abort, 'ticket cambio');
end;

create trigger if not exists linea_cancelada_tope
before update of cancelada_cantidad on venta_lineas
for each row when new.cancelada_cantidad < 0 or new.cancelada_cantidad > new.cantidad
begin
  select raise(abort, 'pieza ya cancelada');
end;

create table if not exists devoluciones (
  id          text primary key,              -- crypto.randomUUID() de la caja: reenviar no duplica
  venta_id    text not null references ventas(id),
  linea_id    integer not null references venta_lineas(id),
  cantidad    integer not null,
  importe     integer not null,              -- dinero devuelto, centavos
  dolarones   integer not null default 0,    -- regresado al saldo del socio
  forma_pago  text not null,                 -- la de la venta: por ahi sale el dinero
  caja        text not null default '',      -- donde se devolvio: su corte lo resta
  corte_id    text,
  autor       text not null,                 -- correo de Access
  motivo      text not null,
  creado_en   text not null
);

create index if not exists devoluciones_venta on devoluciones (venta_id);
create index if not exists devoluciones_caja_corte on devoluciones (caja, corte_id);
