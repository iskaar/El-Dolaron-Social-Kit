-- El precio que mostro la caja gana, con limite (decision de Isaac 7/10). Si el
-- dueno cambia un precio mientras una caja aun tiene el catalogo viejo, la venta
-- se registra al precio que la caja cobro, pero solo si es exactamente el precio
-- anterior y el cambio tiene menos de 10 minutos. Aqui se guarda ese precio y su hora.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-029-precio-anterior.sql
--
-- SQLite no tiene `add column if not exists`: las dos columnas fallan si se
-- corre de nuevo (no pasa nada, ya estan). El trigger si es repetible.

alter table productos add column precio_anterior integer;     -- centavos
alter table productos add column precio_cambiado_en text;     -- ISO UTC

-- Un trigger y no codigo de la app: atrapa cualquier ruta que cambie `precio`
-- (editar, analisis, importaciones). `update of precio` no se dispara a si mismo.
create trigger if not exists productos_precio_anterior
after update of precio on productos
for each row when new.precio <> old.precio
begin
  update productos
     set precio_anterior = old.precio,
         precio_cambiado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   where id = new.id;
end;
