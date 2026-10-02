-- El celular cobra; la caja con Epson toma e imprime el ticket una sola vez.
-- impreso_en registra la toma, no confirma que el papel haya salido.
-- Correr una vez, ANTES de desplegar el codigo que la usa:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-022-impresion-remota.sql

alter table ventas add column imprimir_en text;
alter table ventas add column impreso_en text;

create index ventas_impresiones_pendientes on ventas (imprimir_en, registrado_en)
  where imprimir_en is not null and impreso_en is null and cancelada = 0;
