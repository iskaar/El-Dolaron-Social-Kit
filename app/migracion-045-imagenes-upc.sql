-- Imágenes de referencia del manifiesto (Issue #367). Aditiva; no cambia stock.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-045-imagenes-upc.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-045-imagenes-upc.sql
create table if not exists imagenes_upc (
  upc text primary key,
  tcin text not null,
  url text not null,
  nombre text not null,
  upc_fuente text not null default '',
  confirmado_por text not null default '',
  confirmado_en text not null default ''
);

-- productos.upc conserva el código leído; el manifiesto conserva su clave histórica.
create index if not exists productos_upc_foto on productos (ltrim(upc, '0'), actualizado_en)
  where propietario = 'dolaron' and foto_key <> '' and estado_analisis <> 'descartado';
