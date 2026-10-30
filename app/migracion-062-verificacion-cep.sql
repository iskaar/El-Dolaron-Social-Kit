-- Verificacion de las transferencias contra el CEP de Banxico (#603, fase 2 de #593). Aditiva; solo agrega columnas a transferencias_spei.
-- banco_emisor = codigo Banxico (5 digitos) del banco que envio, de la lista de public/venta.js; null si el cajero eligio «otro» o es anterior a esta migracion (esas no se verifican solas).
-- cep_estado: pendiente | banxico_ok | no_encontrada | no_coincide | validada_manual. Lo escribe solo el script de la PC de la caja (tools/cep_verificar.py) o el dueno.
-- cep_intentos = consultas a Banxico ya hechas (maximo 2: la primera al minuto de registrarse y una sola mas, 30 minutos despues y un dia antes); cep_ultimo_intento = cuando fue la ultima.
-- validada_por / validada_en = el dueno que la dio por buena a mano.
-- comprobante_key = foto del comprobante en R2 (comprobantes/<uuid>.jpg), privada: solo el dueno la ve. fecha_comprobante = la fecha (AAAA-MM-DD) que se leyo en ella, si se leyo.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-062-verificacion-cep.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-062-verificacion-cep.sql | tr '\n' ' ')"
alter table transferencias_spei add column banco_emisor text check (banco_emisor is null or banco_emisor glob '[0-9][0-9][0-9][0-9][0-9]');
alter table transferencias_spei add column cep_estado text not null default 'pendiente' check (cep_estado in ('pendiente', 'banxico_ok', 'no_encontrada', 'no_coincide', 'validada_manual'));
alter table transferencias_spei add column cep_intentos integer not null default 0 check (cep_intentos between 0 and 2);
alter table transferencias_spei add column cep_ultimo_intento text;
alter table transferencias_spei add column validada_por text;
alter table transferencias_spei add column validada_en text;
alter table transferencias_spei add column comprobante_key text check (comprobante_key is null or comprobante_key glob 'comprobantes/*.jpg');
alter table transferencias_spei add column fecha_comprobante text check (fecha_comprobante is null or fecha_comprobante glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
