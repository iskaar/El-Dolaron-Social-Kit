-- Guarda lo que propuso la IA, para poder comparar despues contra lo que Isaac
-- cobra de verdad. Se escribe una sola vez, en el analisis, y las correcciones
-- del admin no lo tocan: es la unica forma de saber en cuanto se equivoca el
-- porcentaje de la configuracion.
--
-- Va justo despues de schema.sql, en una instalacion nueva o existente: schema.sql
-- ya no trae esta columna, para no chocar con este `alter table`.
--
-- Correr una vez:  npx wrangler d1 execute el-dolaron --remote --file=migracion-002-precio-sugerido.sql
alter table productos add column precio_sugerido integer not null default 0;
