-- Prueba de un solo uso del alta en la caja (Issue #844). Aditiva: una tabla nueva.
-- Al dar de alta a un socio en /socios, el servidor devuelve una prueba (DA-...) que deja acreditar SU llegada física sin el código del portal.
-- Solo vive 30 minutos, solo sirve para ese socio y solo a quien hizo el alta (`autor` = la sesión de la caja: en una computadora compartida,
-- el cajero que entró con su PIN). Se guarda el SHA-256, nunca la prueba legible. `usada_en` la consume al acreditar. Gastar Dolarones sigue pidiendo el código DC-.
-- Una prueba por socio: reemitirla (reintento del alta con el mismo id) invalida la anterior.
-- Repetible (create ... if not exists).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-083-prueba-de-alta.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-083-prueba-de-alta.sql

create table if not exists pruebas_alta (
  cliente_id text primary key references clientes(id),
  token_hash text not null unique,
  autor      text not null,
  creado_en  text not null,
  expira_en  text not null,
  usada_en   text not null default ''
);
