-- Reimpresiones que un aparato sin impresora manda a la PC (Issue #787). Aditiva: una columna con valor por omisión; no toca existencias ni productos.
-- reimpresion = 0: deuda de un «+N» de captura (#783; solo la imprime la PC si la etiqueta original salió ANTES de la suma).
-- reimpresion = 1: reimpresión pedida a propósito; la PC la imprime aunque la etiqueta original no sea anterior. Las filas de la migración 074 quedan en 0.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-075-etiquetas-deuda-reimpresion.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-075-etiquetas-deuda-reimpresion.sql
alter table etiquetas_deuda add column reimpresion integer not null default 0;
