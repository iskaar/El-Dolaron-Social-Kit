-- Manifiesto del proveedor y captura por UPC (Issue #365).
-- Correr una vez, antes del deploy (sandbox primero, luego producción):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-044-manifiesto.sql
-- Después, cargar el manifiesto: python tools/importar_manifiesto.py produccion
-- Aditiva. Independiente de otras migraciones.

-- Un renglón por UPC; lo llena tools/importar_manifiesto.py desde la hoja del proveedor.
create table if not exists manifiesto (
  upc           text primary key,              -- solo dígitos, sin ceros a la izquierda
  descripcion   text not null,                 -- la de Target, en inglés y abreviada
  departamento  text not null default '',
  precio_usd    integer not null,              -- centavos USD, precio de lista de Target
  tcin          text not null default '',      -- id de Target: target.com/p/-/A-<tcin>
  nombre        text not null default '',      -- en español, al formato de la tienda; '' = sin traducir
  marca         text not null default '',
  categoria     text not null default '',      -- clave de public/categorias.js, la pone la traducción
  actualizado_en text not null
);

-- De qué UPC del manifiesto salió la pieza; nulo en las capturadas con foto.
alter table productos add column upc text;
create index if not exists productos_upc on productos (upc);
