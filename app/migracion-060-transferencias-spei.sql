-- Clave de rastreo SPEI de cada transferencia recibida (#593, paso 1). Aditiva; no toca ventas, pedidos ni existencias.
-- Una clave solo puede respaldar un pago en toda la tienda: lo garantiza el indice unico, no el codigo. Si la venta o el pago se cancelan, la clave sigue usada.
-- verificacion: cajero = el cajero la copio del comprobante del cliente; banxico queda para cuando se consulte el CEP (paso 2).
-- monto = centavos que dice el comprobante; aplicado = centavos registrados como pago (lo debido); si sobra, se resuelve a mano.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-060-transferencias-spei.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-060-transferencias-spei.sql | tr '\n' ' ')"
create table transferencias_spei (
  id integer primary key,
  clave_rastreo text not null check (clave_rastreo = upper(clave_rastreo) and length(clave_rastreo) between 6 and 30),
  monto integer not null check (typeof(monto) = 'integer' and monto > 0),
  aplicado integer not null check (typeof(aplicado) = 'integer' and aplicado > 0 and aplicado <= monto),
  origen text not null check (origen in ('venta', 'anticipo', 'abono')),
  venta_id text references ventas(id),
  pedido_id text references pedidos(id),
  movimiento_id text references pedido_movimientos(id),
  verificacion text not null default 'cajero' check (verificacion in ('cajero', 'banxico')),
  registrado_por text not null,
  registrado_en text not null,
  check ((origen = 'venta' and venta_id is not null)
      or (origen = 'anticipo' and pedido_id is not null)
      or (origen = 'abono' and pedido_id is not null and movimiento_id is not null))
);
create unique index transferencias_spei_clave on transferencias_spei (clave_rastreo);
