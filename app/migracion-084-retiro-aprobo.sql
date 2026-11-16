-- Quién aprobó un retiro del cajón arriba del tope (#846). Aditiva: una columna nueva, nula, sin tocar ninguna fila existente.
-- Un retiro de tipo 'retiro' arriba del tope que fija el dueño en /reportes (clave `tope_retiro` de `config`, en centavos) lo aprueba el dueño o un
-- supervisor con su PIN en la caja, o lo registra él mismo en su sesión: aquí queda su correo. Nula = no hizo falta aprobación (bajo el tope, gasto, entrada de terminal o retiro anterior).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en producción:
-- npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file=migracion-084-retiro-aprobo.sql
-- npx wrangler d1 execute el-dolaron --remote --file=migracion-084-retiro-aprobo.sql

alter table retiros add column aprobo_por text;
