-- Familias de banda por propietario (Issue #694): FEP (finanzas) tiene las suyas.
-- Hasta hoy todas las familias y sus productos de banda eran de El Dolaron; una banda de
-- FEP vendida en caja habria contado como venta de la tienda. Los productos de banda ya
-- tienen `propietario` (migracion 032); ahora la familia tambien. Las existentes quedan
-- como 'dolaron' por el default.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-067-familias-propietario.sql
--
-- No es repetible: el add column falla si ya existe.

alter table familias add column propietario text not null default 'dolaron';   -- 'dolaron' | 'fep'
