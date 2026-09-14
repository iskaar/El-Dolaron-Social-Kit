-- Con la puerta del vendedor abierta a cualquier correo de Gmail, hace falta
-- saber quien subio cada foto: Cloudflare Access ya identifica a la persona,
-- solo faltaba guardarlo. Sirve para borrar lo de un desconocido sin tocar lo
-- del vendedor, y para cerrar la puerta con datos en la mano.
--
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-005-capturado-por.sql
alter table productos add column capturado_por text not null default '';
