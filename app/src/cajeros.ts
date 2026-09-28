/**
 * PIN del cajero (Issue #112). La computadora de caja entra a Access una vez
 * con la cuenta de la tienda (rol `computadora`), que sola no cobra: cada
 * cajero elige su nombre y escribe su PIN de 6 digitos, y la pantalla manda el
 * token en `x-cajero`. Desde ahi todo lo de caja queda a su nombre y en su
 * caja. El PIN solo abre lo de caja: reportes y cuentas siguen pidiendo el
 * correo del dueno (ver worker.ts).
 */
import { hashPin, hex, INTENTOS_PIN, BLOQUEO_PIN } from './dolarones.ts';
import { leerUsuario, leerRoles, type Usuario, type Rol } from './cuentas.ts';

export const ENCABEZADO = 'x-cajero';
// ponytail: la sesion aguanta un turno largo; el bloqueo por 1 hora sin uso lo
// hace la pantalla (cajero.js). Si hiciera falta en el servidor: expira_en
// deslizante, a costa de una escritura por peticion.
const DURACION = 14 * 3600_000;

const puedeCobrar = (roles: Rol[]) => roles.includes('cajero') || roles.includes('dueno');
const sha = async (token: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** El cajero en turno segun `x-cajero`, o null. Desactivarlo o quitarle el rol corta su sesion al momento. */
export async function cajeroEnTurno(request: Request, env: Env): Promise<Usuario | null> {
  const token = request.headers.get(ENCABEZADO);
  if (!token) return null;
  const fila = await env.DB.prepare('select correo from sesiones_cajero where token_hash = ? and expira_en > ?')
    .bind(await sha(token), new Date().toISOString())
    .first<{ correo: string }>();
  if (!fila) return null;
  const usuario = await leerUsuario(env, fila.correo);
  return usuario?.activo && puedeCobrar(usuario.roles) ? usuario : null;
}

/** Los nombres para la pantalla de bloqueo: quien puede cobrar y ya tiene PIN. */
export async function listarCajeros(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select correo, nombre, roles from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string }>();
  return json(results.filter((u) => puedeCobrar(leerRoles(u.roles))).map(({ correo, nombre }) => ({ correo, nombre })));
}

export async function entrar(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { correo?: unknown; pin?: unknown };
  const correo = String(cuerpo.correo ?? '').trim().toLowerCase();
  const pin = String(cuerpo.pin ?? '');
  if (!/^\d{6}$/.test(pin)) return json({ error: 'El PIN es de 6 digitos.' }, 400);
  const fila = await env.DB.prepare(
    `select correo, nombre, roles, caja, pin_hash, pin_sal, pin_bloqueo from usuarios
     where correo = ? and activo = 1 and pin_hash != ''`,
  )
    .bind(correo)
    .first<{ correo: string; nombre: string; roles: string; caja: string; pin_hash: string; pin_sal: string; pin_bloqueo: string }>();
  if (!fila || !puedeCobrar(leerRoles(fila.roles))) return json({ error: 'Sin PIN. Pideselo al dueno.' }, 404);

  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  if (fila.pin_bloqueo > ahoraIso) return json({ error: 'PIN bloqueado por intentos fallidos. Espera 15 minutos o llama a Isaac.' }, 423);
  if (await hashPin(pin, fila.pin_sal) !== fila.pin_hash) {
    // Igual que el PIN de socios: incremento atomico, sin tocar un PIN recien cambiado.
    const fallo = await env.DB.prepare(
      `update usuarios set
         pin_fallos = case when pin_fallos + 1 >= ? then 0 else pin_fallos + 1 end,
         pin_bloqueo = case when pin_fallos + 1 >= ? then ? else pin_bloqueo end
       where correo = ? and pin_bloqueo <= ? and pin_hash = ?
       returning pin_bloqueo`,
    ).bind(INTENTOS_PIN, INTENTOS_PIN, new Date(ahora.getTime() + BLOQUEO_PIN).toISOString(),
      correo, ahoraIso, fila.pin_hash).first<{ pin_bloqueo: string }>();
    return json({ error: fallo && fallo.pin_bloqueo > ahoraIso ? 'PIN incorrecto. Se bloqueo 15 minutos.' : 'PIN incorrecto.' }, 403);
  }

  // Confirmar y limpiar fallos juntos: el PIN o el bloqueo pudieron cambiar durante PBKDF2.
  const autorizado = await env.DB.prepare(
    `update usuarios set pin_fallos = 0 where correo = ? and pin_hash = ? and pin_bloqueo <= ? returning correo`,
  ).bind(correo, fila.pin_hash, ahoraIso).first();
  if (!autorizado) return json({ error: 'PIN bloqueado o recien cambiado. Intenta otra vez.' }, 423);

  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('delete from sesiones_cajero where expira_en <= ?').bind(ahoraIso),
    env.DB.prepare('insert into sesiones_cajero (token_hash, correo, creado_en, expira_en) values (?, ?, ?, ?)')
      .bind(await sha(token), correo, ahoraIso, new Date(ahora.getTime() + DURACION).toISOString()),
  ]);
  return json({ token, correo, nombre: fila.nombre, caja: fila.caja }, 201);
}

export async function salir(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get(ENCABEZADO);
  if (token) await env.DB.prepare('delete from sesiones_cajero where token_hash = ?').bind(await sha(token)).run();
  return json({ ok: true });
}

/** El dueno pone o cambia el PIN desde /cuentas. Cambiarlo cierra las sesiones abiertas de esa persona. */
export async function ponerPin(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { correo?: unknown; pin?: unknown };
  const correo = String(cuerpo.correo ?? '').trim().toLowerCase();
  const pin = String(cuerpo.pin ?? '');
  if (!/^\d{6}$/.test(pin)) return json({ error: 'El PIN debe tener 6 digitos.' }, 400);
  if (!(await leerUsuario(env, correo))) return json({ error: 'No existe esa cuenta.' }, 404);
  const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare(`update usuarios set pin_hash = ?, pin_sal = ?, pin_fallos = 0, pin_bloqueo = '' where correo = ?`)
      .bind(await hashPin(pin, sal), sal, correo),
    env.DB.prepare('delete from sesiones_cajero where correo = ?').bind(correo),
  ]);
  return json({ correo, tiene_pin: true });
}
