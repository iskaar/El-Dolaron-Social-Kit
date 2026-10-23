-- Etiquetas enviadas a la impresora (Issue #440). Aditiva; no toca existencias ni productos.
-- Una fila por pieza: lo que dice la etiqueta que salio y desde donde (pc o celular). La PC (/etiquetas) y el celular (/escanear) la reclaman antes de imprimir para no sacar la misma etiqueta dos veces.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción (el archivo es una sola sentencia, sin comentarios al final de línea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-049-etiqueta-impresa.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-049-etiqueta-impresa.sql
create table if not exists etiquetas_enviadas (producto_id text primary key, etiqueta_en text not null, etiqueta_precio integer not null, etiqueta_precio_lista integer not null, etiqueta_nombre text not null, etiqueta_talla text not null, etiqueta_origen text not null);
