-- Inventario separado: El Dolaron y FEP (Finanzas) comparten la misma base y la
-- misma caja, pero el inventario y los reportes de la tienda son solo de 'dolaron'.
-- FEP cobra todo lo que se vende de sus piezas; la tienda paga el cashback de
-- Dolarones tambien sobre esas ventas (Issue #298).
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-032-propietario.sql
--
-- No es repetible: cada add column falla si ya existe.

alter table productos add column propietario text not null default 'dolaron';   -- 'dolaron' | 'fep'
create index if not exists productos_propietario on productos (propietario);

-- Congelado al vender, como el precio: si la pieza cambia despues, la venta sigue siendo de quien era.
alter table venta_lineas add column propietario text not null default 'dolaron';

-- Lo que se le debe a FEP en este corte: lo cobrado de sus piezas, neto de devoluciones.
alter table cortes add column fep_por_pagar integer not null default 0;
