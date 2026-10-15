-- Pedidos por WhatsApp, fase 1 (Issue #269): apartado con anticipo, saldo a favor y envio.
-- Crear un pedido recibe el anticipo y baja la existencia en D1 (el maestro de stock);
-- al vencer o cancelarse las piezas vuelven y el anticipo queda como saldo a favor
-- por un mes. La venta que cierra el pedido pasa por registrarVenta y descuenta el
-- anticipo de lo que se cobra (ventas.anticipo).
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-033-pedidos.sql
--
-- Aditiva. Falla si se corre de nuevo (las columnas de ventas ya existen): no pasa nada.
-- (032 la usa el PR #259.)

create table if not exists pedidos (
  id             text primary key,                 -- uuid del cliente: reintentar no duplica
  folio          integer not null unique,          -- P-17: lo que se dice por WhatsApp y se escribe en la caja
  cliente        text not null,
  telefono       text not null,                    -- 10 digitos
  entrega        text not null check (entrega in ('tienda', 'envio')),
  envio          integer not null default 0,       -- centavos: 9900 o 0, fijado al crear
  vendedora      text not null,                    -- correo de quien lo levanto
  estado         text not null check (estado in ('apartado', 'vendido', 'vencido', 'cancelado')),
  vence_en       text not null,                    -- creado + 7 dias
  anticipo       integer not null check (anticipo >= 10000),
  forma_pago     text not null check (forma_pago in ('efectivo', 'tarjeta', 'transferencia')),
  caja           text not null default '',         -- donde entro el dinero (corte)
  corte_id       text,
  -- Lo que queda del anticipo a favor del cliente. El CHECK es el candado: dos
  -- ventas que gastan el mismo saldo hacen que la segunda aborte su batch (patron de vales.ts).
  saldo          integer not null check (saldo >= 0),
  saldo_vence_en text not null,
  venta_id       text references ventas(id),       -- la venta que cerro el apartado
  guia           text not null default '',
  creado_en      text not null,
  actualizado_en text not null
);
-- Mismo candado con texto propio (como vale_saldo_valido): worker.ts lo reconoce sin depender del mensaje del CHECK.
create trigger if not exists pedido_saldo_valido before update of saldo on pedidos
when new.saldo < 0
begin
  select raise(abort, 'saldo de pedido invalido');
end;
create index if not exists pedidos_estado on pedidos (estado, vence_en);
create index if not exists pedidos_caja_corte on pedidos (caja, corte_id);

create table if not exists pedido_lineas (
  pedido_id   text not null references pedidos(id),
  producto_id text not null references productos(id),
  cantidad    integer not null check (cantidad > 0),
  primary key (pedido_id, producto_id)
);

alter table ventas add column anticipo integer not null default 0;   -- parte del total pagada con saldo de pedido (centavos)
alter table ventas add column pedido_id text references pedidos(id);

-- El envio como producto de la caja, igual que los bins (migracion-003): no descuenta existencias.
insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en)
values
  ('00000000-0000-4000-8000-000000000099', 'ENVIO', 'Envío', 'otros', 0, 9900, 'nuevo',
   'listo', 'envio', 0, 1, 'S00', '', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')
on conflict (id) do nothing;
