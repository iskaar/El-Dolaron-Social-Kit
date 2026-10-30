-- Notificaciones push al dueño (#600): una fila por dispositivo que activó las notificaciones en /avisos. Aditiva.
-- endpoint = URL del servicio de push del navegador (Apple, Google, Mozilla); p256dh y auth = llaves del dispositivo para cifrar.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-061-push.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-061-push.sql | tr '\n' ' ')"
create table push_suscripciones (
  endpoint text primary key,
  correo text not null,
  p256dh text not null,
  auth text not null,
  creado_en text not null
);
