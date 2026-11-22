-- «Sin etiqueta» (Issue #880): una pieza que no tiene etiqueta ni esta en bandas (una bocina de $600) se cobra en la
-- caja escribiendo que es y cuanto cuesta, sin darla de alta. Es UN producto fijo de catalogo, como el envio (migracion 035):
-- no lleva existencias (sin_inventario = 1) y su precio en `productos` es 0 a proposito. El precio de cada venta lo escribe el
-- cajero y el servidor solo lo acepta para este producto (prepararLineas en worker.ts, de $1 a $20,000); con precio 0 el
-- catalogo de la caja no lo trae (no sale al escanear ni al buscar), no se puede apartar y no entra a las listas de inventario.
-- La caja lo agrega por su UUID fijo (LIBRE_ID en public/venta.js), no por el catalogo.
-- Las fechas son viejas a proposito: asi no viaja en el catalogo incremental (no hace falta, la caja no lo busca).
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-086-sin-etiqueta.sql
--
-- Aditiva y repetible: si ya existe no hace nada. Sin esta fila, cobrar una pieza sin etiqueta responde «Producto inexistente.».

insert or ignore into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                                 estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                                 foto_key, creado_en, actualizado_en, propietario)
values
  ('00000000-0000-4000-8000-000000000098', 'LIBRE', 'Sin etiqueta', 'otros', 0, 0, 'nuevo',
   'listo', 'libre', 0, 1, 'S00', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dolaron');
