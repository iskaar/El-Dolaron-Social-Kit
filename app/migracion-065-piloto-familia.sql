-- Piloto familia y amigos de referidos (#631). Aditiva; no toca socios, lotes ni referidos existentes.
-- Quien se une con el codigo del piloto (CODIGO_PILOTO en app/src/referidos.ts) queda en esta tabla:
-- recibe 50 D al unirse y es el unico que tiene codigo DOL para invitar. Tope de 50 registros (MAXIMO_PILOTO).
-- Isaac ejecuta ANTES del deploy, primero en sandbox y luego en produccion (sin comentarios al final de linea).
-- PowerShell, desde app/ (sandbox):
-- Get-Content migracion-065-piloto-familia.sql | Where-Object { $_ -notmatch '^\s*--' } | Set-Content -Encoding ascii "$env:TEMP\mig.sql"; npx wrangler d1 execute el-dolaron-sandbox --remote --config wrangler.sandbox.jsonc --file "$env:TEMP\mig.sql"
-- PowerShell, desde app/ (produccion):
-- Get-Content migracion-065-piloto-familia.sql | Where-Object { $_ -notmatch '^\s*--' } | Set-Content -Encoding ascii "$env:TEMP\mig.sql"; npx wrangler d1 execute el-dolaron --remote --file "$env:TEMP\mig.sql"
-- Re-ejecutable (if not exists).

create table if not exists piloto_socios (
  cliente_id text primary key references clientes(id),
  creado_en text not null
);

-- Si dos altas se pelean el ultimo lugar, la segunda aborta su batch completo (socio, lote y movimiento).
create trigger if not exists piloto_tope
before insert on piloto_socios
when (select count(*) from piloto_socios) >= 50
begin
  select raise(abort, 'tope del piloto');
end;
