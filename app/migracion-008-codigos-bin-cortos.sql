-- "BIN-20" (6 caracteres) no cabe en el codigo de barras de la etiqueta
-- chica (50.8mm) al mismo modulo que usan los productos (0.5mm): para que
-- la etiqueta de bin sea una etiqueta normal -- mismo modulo, mismo tamano --
-- el codigo se acorta a 3 caracteres. Sigue sin ser puramente numerico, asi
-- que buscarPieza() en caja.html nunca lo confunde con un numero de producto
-- reconstruido (ese camino solo dispara si el codigo escaneado es /^\d+$/).
--
-- Correr una vez, despues de migracion-007:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-008-codigos-bin-cortos.sql
update productos set codigo = 'B20' where codigo = 'BIN-20';
update productos set codigo = 'B40' where codigo = 'BIN-40';
update productos set codigo = 'B60' where codigo = 'BIN-60';
