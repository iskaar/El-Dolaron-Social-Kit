-- Marca de cada producto y busqueda por categoria (Issue #159).
-- La reclasificacion de los productos existentes es aparte: son ids de
-- produccion y viven fuera del repo.
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-023-marca.sql

alter table productos add column marca text not null default '';

create index productos_categoria on productos (categoria);

-- El admin guarda un porcentaje por categoria: las nuevas arrancan con el de
-- «otros» (con el que ya se calculaban), para que nadie guarde un 0 vacio.
insert or ignore into config (clave, valor)
  select 'pct_' || c.value, o.valor
  from config o, json_each('["accesorios","belleza","jardin","mascotas","papeleria","despensa","deportes"]') c
  where o.clave = 'pct_otros';   -- json_each: D1 limita los «union all» de un select
