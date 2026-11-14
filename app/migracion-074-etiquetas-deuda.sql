-- Etiquetas que se deben por un «+N» de captura (Issue #783). Aditiva; no toca existencias ni productos.
-- Una fila por suma, con el mismo folio de su ajuste auditado en conteo_ajustes (id = folio, así un reintento no la duplica).
-- reclamada_en vacío = nadie la ha sacado; con hora = la reclamó una pantalla (el celular que sumó o la automática de la PC) y otra ya no la repite.
-- El índice parcial deja que la consulta de la PC (cada 3 s) lea solo lo pendiente.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-074-etiquetas-deuda.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-074-etiquetas-deuda.sql
create table if not exists etiquetas_deuda (
  id text primary key,
  producto_id text not null,
  copias integer not null,
  creado_en text not null,
  reclamada_en text not null default ''
);
create index if not exists etiquetas_deuda_pendientes on etiquetas_deuda (creado_en) where reclamada_en = '';
