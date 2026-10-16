-- Cupones de Dolarones en lugar de devolver dinero (Issue #330).
-- Un cupón es un vale sin compra que lo emita: `venta_id` queda null y `origen` dice de dónde salió
-- (devolucion: piezas devueltas de `venta_origen`; manual: monto libre que autorizó un dueño).
-- Se canjea en la caja igual que cualquier vale.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-039-cupones.sql
--
-- SQLite no quita un NOT NULL: se reconstruye vales_dolarones con los mismos datos. Su hija
-- vales_movimientos se aparta antes y se recrea igual al final: borrar una tabla que todavía
-- tiene hijas cuenta como violación de llave foranea aunque la nueva se renombre igual.
pragma defer_foreign_keys = on;

create table vales_movimientos_copia as select * from vales_movimientos;
drop table vales_movimientos;

create table vales_dolarones_nueva (
  id text primary key,
  venta_id text unique references ventas(id),   -- la compra que lo gano; null en cupones
  codigo text not null unique,
  importe integer not null check (importe > 0),
  restante integer not null check (restante >= 0 and restante <= importe),
  disponible_desde text not null,
  vence_en text not null,
  creado_en text not null,
  reclamado_por text,
  reclamado_en text,
  origen text not null default 'compra' check (origen in ('compra', 'devolucion', 'manual')),
  venta_origen text,                            -- devolucion: el ticket del que se devolvieron las piezas
  motivo text not null default '',
  autor text not null default '',               -- quien lo emitio
  aprobado_por text,                            -- manual: el dueno que lo autorizo
  check ((origen = 'compra') = (venta_id is not null))
);
insert into vales_dolarones_nueva (id, venta_id, codigo, importe, restante, disponible_desde, vence_en, creado_en,
  reclamado_por, reclamado_en)
  select id, venta_id, codigo, importe, restante, disponible_desde, vence_en, creado_en, reclamado_por, reclamado_en
  from vales_dolarones;
drop table vales_dolarones;
alter table vales_dolarones_nueva rename to vales_dolarones;

create trigger vale_saldo_valido before update of restante on vales_dolarones
when new.restante < 0 or new.restante > new.importe
begin
  select raise(abort, 'saldo de vale invalido');
end;
create index vales_reclamos on vales_dolarones (reclamado_por, reclamado_en) where reclamado_por is not null;
create index vales_venta_origen on vales_dolarones (venta_origen) where venta_origen is not null;

-- Igual que en la migracion 019.
create table vales_movimientos (
  id integer primary key,
  vale_id text not null references vales_dolarones(id),
  venta_id text not null references ventas(id),
  tipo text not null check (tipo in ('emision', 'canje', 'reverso_canje', 'retiro')),
  importe integer not null,
  autor text not null,
  creado_en text not null,
  unique (vale_id, venta_id, tipo)
);
insert into vales_movimientos (id, vale_id, venta_id, tipo, importe, autor, creado_en)
  select id, vale_id, venta_id, tipo, importe, autor, creado_en from vales_movimientos_copia;
drop table vales_movimientos_copia;

-- Lo devuelto en cupón tambien suma a ventas.devuelto (reportes y tickets lo restan igual que
-- una devolucion), pero ese dinero se queda en el cajon: el corte lo vuelve a sumar.
alter table ventas add column devuelto_cupon integer not null default 0;
-- En la devolucion por cupón `importe` (dinero que sale) es 0; `cupon` es el dinero que se paso al cupón.
alter table devoluciones add column cupon integer not null default 0;
alter table devoluciones add column vale_id text;
