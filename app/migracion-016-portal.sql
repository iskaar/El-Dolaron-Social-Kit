-- #109. Ejecutar antes del Worker; las altas públicas siguen cerradas sin bases aprobadas.
alter table clientes add column auth_uid text;
alter table clientes add column bases_aceptadas_en text;
create unique index clientes_auth_uid on clientes (auth_uid) where auth_uid is not null;
create index ventas_cliente_historial on ventas (cliente_id, registrado_en desc, id desc);

-- Cupos nominales fijos: la fila libre más antigua gana. Un cupo liberado
-- conserva su posición; un premio vencido sigue ocupado y no se reasigna.
create table premios_apertura (
  canal text not null check (canal in ('online', 'tienda')),
  orden integer not null check (orden between 1 and 50),
  importe integer not null check (importe > 0),
  cliente_id text unique references clientes(id),
  lote_id text unique,
  primary key (canal, orden)
);
with recursive n(orden) as (select 1 union all select orden + 1 from n where orden < 50)
insert into premios_apertura (canal, orden, importe)
select 'online', orden, 100 * case when orden <= 5 then 300 when orden <= 11 then 200 when orden <= 25 then 150 else 100 end from n
union all
select 'tienda', orden, 100 * case when orden = 1 then 500 when orden <= 6 then 300 when orden <= 13 then 200 when orden <= 25 then 150 else 100 end from n;

-- La primera llegada queda reservada aun si el reemplazo exige resolución.
create table primera_llegada (
  singleton integer primary key check (singleton = 1),
  cliente_id text not null unique references clientes(id),
  acreditado_por text not null,
  acreditado_en text not null
);
