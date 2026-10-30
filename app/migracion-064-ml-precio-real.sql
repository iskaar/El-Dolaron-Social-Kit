-- Precio real, comision y envio de cada venta de Mercado Libre (#621). Aditiva; no toca existencias ni el flujo de la orden.
-- precio_unitario = unit_price de la orden, en centavos MXN. comision_unitaria = sale_fee de la orden por pieza, en centavos. Los dos vienen de /orders/{id}.
-- envio_vendedor = lo que paga la tienda por el envio de la orden (senders[].cost de /shipments/{id}/costs), en centavos; va completo en la primera fila de la orden y 0 en las demas. Sin envio cobrado queda en 0.
-- NULL = todavia no se lee (o ML fallo): el tablero usa el precio publicado como estimado y el cron lo reintenta en lotes chicos.
-- precio_leido_en = cuando se guardo el precio. precio_intentos = lecturas fallidas del relleno; con 8 deja de insistir.
-- La retencion de ISR/IVA no se guarda: ML no la entrega de forma confiable en la orden.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea).
-- PowerShell, desde app/ (sandbox):
-- Get-Content migracion-064-ml-precio-real.sql | Where-Object { $_ -notmatch '^\s*--' } | Set-Content -Encoding ascii "$env:TEMP\mig.sql"; npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file "$env:TEMP\mig.sql"
-- PowerShell, desde app/ (produccion):
-- Get-Content migracion-064-ml-precio-real.sql | Where-Object { $_ -notmatch '^\s*--' } | Set-Content -Encoding ascii "$env:TEMP\mig.sql"; npx wrangler d1 execute el-dolaron --remote --file "$env:TEMP\mig.sql"
-- NO es re-ejecutable: SQLite no tiene add column if not exists; si falla con duplicate column name, ya estaba aplicada.
-- Bash (alternativa):
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --command "$(grep -v '^\s*--' migracion-064-ml-precio-real.sql | tr '\n' ' ')"
-- npx wrangler d1 execute el-dolaron --remote --command "$(grep -v '^\s*--' migracion-064-ml-precio-real.sql | tr '\n' ' ')"
alter table ml_ventas add column precio_unitario integer;
alter table ml_ventas add column comision_unitaria integer;
alter table ml_ventas add column envio_vendedor integer;
alter table ml_ventas add column precio_leido_en text;
alter table ml_ventas add column precio_intentos integer not null default 0;
