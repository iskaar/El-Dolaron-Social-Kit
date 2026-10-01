-- #133: vales anónimos, sin crear socios ni alterar sus lotes.
create table vales_dolarones (
  id text primary key,
  venta_id text not null unique references ventas(id),
  codigo text not null unique,
  importe integer not null check (importe > 0),
  restante integer not null check (restante >= 0 and restante <= importe),
  disponible_desde text not null,
  vence_en text not null,
  creado_en text not null
);
create trigger vale_saldo_valido before update of restante on vales_dolarones
when new.restante < 0 or new.restante > new.importe
begin
  select raise(abort, 'saldo de vale invalido');
end;
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
