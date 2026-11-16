-- Ventas cobradas sin red que el servidor rechazó al sincronizar (Issue #819). Aditiva: una tabla nueva, sin tocar ninguna existente.
-- La caja la reporta aquí (idempotente por el folio de la venta) y el dueño la ve y la marca resuelta en /avisos. No mueve existencias ni dinero.
-- No usa `solicitudes`: esa tabla es de aprobaciones (pendiente|aprobada|rechazada), /cuentas lista TODAS las pendientes y su resolver
-- solo entiende acceso, cancelación y descuento; una venta rechazada no se aprueba ni se rechaza, se resuelve con una nota.
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-079-ventas-rechazadas.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-079-ventas-rechazadas.sql

create table if not exists ventas_rechazadas (
  id text primary key,                       -- el folio (UUID) de la venta en la caja: reportar dos veces es una sola fila
  tienda text not null,                      -- de la cuenta de Access de la terminal, nunca del navegador
  caja text not null default '',
  cajero text not null,                      -- quien tenía la sesión (PIN) al reportar
  creado_en text not null,                   -- hora de la venta en la caja
  reportada_en text not null,
  forma_pago text not null,
  efectivo integer not null default 0,       -- centavos
  total integer not null,                    -- centavos: suma de las piezas del ticket tal como lo reportó la caja
  piezas integer not null,
  lineas text not null,                      -- JSON [{codigo, nombre, cantidad, precio}]; nada del cliente
  motivo text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'resuelta')),
  nota text not null default '',
  resuelta_en text,
  resuelta_por text
);

create index if not exists ventas_rechazadas_pendientes on ventas_rechazadas (estado, reportada_en);
