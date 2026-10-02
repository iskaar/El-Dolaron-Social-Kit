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
  select 'pct_' || c.clave, o.valor
  from config o, (select 'accesorios' clave union all select 'belleza' union all select 'jardin'
    union all select 'mascotas' union all select 'papeleria' union all select 'despensa'
    union all select 'deportes') c
  where o.clave = 'pct_otros';
