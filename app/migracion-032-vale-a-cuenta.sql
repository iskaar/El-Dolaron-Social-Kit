-- Pasar un vale de papel a una cuenta (Issue #258): al escanear el QR del vale
-- y registrarse, el vale se cierra y su compra se abona con la tarifa de socio.
-- reclamado_por = clientes.id; con el se cuenta el limite por semana.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-032-vale-a-cuenta.sql
--
-- Las columnas fallan si se corre de nuevo (no pasa nada, ya estan); el indice es repetible.

alter table vales_dolarones add column reclamado_por text;
alter table vales_dolarones add column reclamado_en text;
create index if not exists vales_reclamos on vales_dolarones (reclamado_por, reclamado_en) where reclamado_por is not null;
