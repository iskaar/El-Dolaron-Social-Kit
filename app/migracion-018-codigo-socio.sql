-- #129: elimina solo el PIN del CLIENTE. El PIN de cajero (usuarios) continúa.
alter table clientes drop column pin_hash;
alter table clientes drop column pin_sal;
alter table clientes drop column pin_fallos;
alter table clientes drop column pin_bloqueo;

-- Una autorización vigente por socio: regenerarla invalida la anterior.
-- Nunca se guarda el código legible, sólo SHA-256. No se borran filas durante
-- el checkout: la sentencia de consumo siempre encuentra el socio que leyó.
create table codigos_cliente (
  cliente_id text primary key references clientes(id),
  token_hash text not null unique,
  auth_uid text not null,
  maximo integer not null check (maximo >= 0),
  creado_en text not null,
  expira_en text not null,
  venta_id text not null default ''
);
create trigger codigo_cliente_valido before update of venta_id on codigos_cliente
when new.venta_id is null
begin
  select raise(abort, 'codigo de socio invalido');
end;

-- Vincular un alta presencial requiere control del teléfono y aprobación del
-- dueño en persona. Nunca se enlaza una cuenta sólo por conocer su teléfono.
create table vinculos_portal (
  auth_uid text primary key,
  token_hash text not null unique,
  telefono text not null,
  creado_en text not null,
  expira_en text not null
);
