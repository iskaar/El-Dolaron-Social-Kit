-- Verificacion de las transferencias contra el CEP de Banxico (#603, fase 2 de #593). Aditiva; solo agrega columnas a transferencias_spei.
-- banco_emisor = codigo Banxico (5 digitos) del banco que envio, de la lista de public/venta.js; null si el cajero eligio «otro» o es anterior a esta migracion (esas no se verifican solas).
-- cep_estado: pendiente | banxico_ok | no_encontrada | no_coincide | validada_manual. Lo escribe solo el script de la PC de la caja (tools/cep_verificar.py) o el dueno.
-- cep_intentos = consultas a Banxico ya hechas (maximo 2: el dia del registro y el anterior); cep_ultimo_intento = cuando fue la ultima.
-- validada_por / validada_en = el dueno que la dio por buena a mano.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-062-verificacion-cep.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-062-verificacion-cep.sql | tr '\n' ' ')"
alter table transferencias_spei add column banco_emisor text check (banco_emisor is null or banco_emisor glob '[0-9][0-9][0-9][0-9][0-9]');
alter table transferencias_spei add column cep_estado text not null default 'pendiente' check (cep_estado in ('pendiente', 'banxico_ok', 'no_encontrada', 'no_coincide', 'validada_manual'));
alter table transferencias_spei add column cep_intentos integer not null default 0 check (cep_intentos between 0 and 2);
alter table transferencias_spei add column cep_ultimo_intento text;
alter table transferencias_spei add column validada_por text;
alter table transferencias_spei add column validada_en text;
