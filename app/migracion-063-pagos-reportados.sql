-- Pago reportado por la revendedora (#609). Aditiva; no toca ventas, pedidos ni existencias.
-- pagos_reportados: la revendedora avisa que su cliente ya pago un apartado por transferencia y manda la foto del comprobante y/o la clave de rastreo.
-- NO da el pedido por pagado: la tienda lo acepta registrando el abono de siempre (entonces pasa a aceptado y guarda el movimiento) o lo rechaza con motivo.
-- Un solo reporte pendiente por pedido (indice parcial). Mientras hay uno pendiente el cron no vence el apartado.
-- solicitud_id = UUID del navegador: el reintento de una respuesta perdida no crea otro reporte.
-- comprobante_key = foto en R2 (comprobantes/<uuid>.jpg), privada: solo el dueno la ve. fecha_comprobante = la que se leyo en ella, si se leyo.
-- comprobantes_subidos: de quien y de que pedido es cada foto que subio una revendedora; sin esto no se puede adjuntar la foto de otra ni subir fotos sin tope (cada una cuesta una lectura).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-063-pagos-reportados.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-063-pagos-reportados.sql | tr '\n' ' ')"
create table pagos_reportados (
  id integer primary key,
  pedido_id text not null references pedidos(id),
  solicitud_id text not null unique,
  clave_rastreo text check (clave_rastreo is null or (clave_rastreo = upper(clave_rastreo) and length(clave_rastreo) between 6 and 30)),
  banco_emisor text check (banco_emisor is null or banco_emisor glob '[0-9][0-9][0-9][0-9][0-9]'),
  monto integer check (monto is null or (typeof(monto) = 'integer' and monto > 0)),
  comprobante_key text check (comprobante_key is null or comprobante_key glob 'comprobantes/*.jpg'),
  fecha_comprobante text check (fecha_comprobante is null or fecha_comprobante glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptado', 'rechazado')),
  motivo text not null default '',
  reportado_por text not null,
  reportado_en text not null,
  revisado_por text,
  revisado_en text,
  movimiento_id text references pedido_movimientos(id),
  check (clave_rastreo is not null or comprobante_key is not null)
);
create unique index pagos_reportados_pendiente on pagos_reportados (pedido_id) where estado = 'pendiente';
create index pagos_reportados_pedido on pagos_reportados (pedido_id, id);
create table comprobantes_subidos (
  comprobante_key text primary key check (comprobante_key glob 'comprobantes/*.jpg'),
  pedido_id text not null references pedidos(id),
  subido_por text not null,
  subido_en text not null
);
create index comprobantes_subidos_pedido on comprobantes_subidos (pedido_id);
