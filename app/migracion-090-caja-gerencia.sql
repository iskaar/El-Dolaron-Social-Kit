-- Caja de gerencia: saldo esperado y arqueos (Issue #910, fase 2 de #908). Aditiva: dos columnas nuevas y dos tablas nuevas;
-- no cambia `origen` ni su CHECK, ni ninguna fila existente (las filas anteriores quedan con pagado_con = '').
-- `pagado_con` de un gasto o de un pago/adelanto de nómina con origen 'fuera': 'efectivo' o 'banco' (transferencia). '' = origen 'caja' o fila anterior;
-- solo 'efectivo' mueve el saldo. Un cliente viejo que no manda `pagado_con` guarda 'efectivo' (lo decide el servidor, no esta migración).
-- `dinero_movimientos`: lo que gerencia mueve a mano (deposito al banco, a_tienda = cambio o fondo, entrada, salida); importe positivo en centavos.
-- `arqueos`: gerencia cuenta el efectivo y lo compara con lo esperado. No se editan ni se borran (no hay ruta que lo haga). El primero fija el saldo
-- inicial: esperado = contado, diferencia 0. Todo en centavos enteros.
--
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-090-caja-gerencia.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-090-caja-gerencia.sql
-- Correrla UNA sola vez: el `alter table ... add column` falla si la columna ya existe (las tablas sí admiten repetirse).

alter table gastos add column pagado_con text not null default '' check (pagado_con in ('', 'efectivo', 'banco'));
alter table nomina_movimientos add column pagado_con text not null default '' check (pagado_con in ('', 'efectivo', 'banco'));

create table if not exists dinero_movimientos (
  id         text primary key,                   -- UUID de la pantalla: reenviar no duplica
  fecha      text not null,                      -- YYYY-MM-DD, hora de México
  tipo       text not null check (tipo in ('deposito', 'a_tienda', 'entrada', 'salida')),
  importe    integer not null check (importe > 0),
  nota       text not null default '',
  creado_por text not null,
  creado_en  text not null,
  check (tipo in ('deposito', 'a_tienda') or nota != '')   -- una entrada o salida sin explicar no se guarda
);
create index if not exists dinero_movimientos_fecha on dinero_movimientos (fecha, creado_en);

create table if not exists arqueos (
  id         text primary key,                   -- UUID de la pantalla: reenviar no duplica
  fecha      text not null,                      -- YYYY-MM-DD, hora de México
  esperado   integer not null,                   -- puede ser negativo si salió más de lo que había
  contado    integer not null check (contado >= 0),
  diferencia integer not null,                   -- contado - esperado
  nota       text not null default '',
  creado_por text not null,
  creado_en  text not null,
  check (diferencia = contado - esperado),
  check (diferencia = 0 or nota != '')           -- una diferencia sin explicar no se guarda
);
create index if not exists arqueos_creado on arqueos (creado_en);
