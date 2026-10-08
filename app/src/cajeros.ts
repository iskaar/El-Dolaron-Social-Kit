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

interface FilaPin { correo: string; nombre: string; roles: string; caja: string; pin_hash: string; pin_sal: string; pin_bloqueo: string }

/**
 * Verifica el PIN de 6 digitos de `correo` (PBKDF2, contador de fallos y bloqueo
 * de 15 minutos). Lo usan el acceso del cajero y la aprobacion del dueno
 * (cancelaciones.ts): mismas reglas en los dos. `admite` filtra los roles validos.
 */
export async function verificarPin(
  env: Env, correo: string, pin: string, admite: (roles: Rol[]) => boolean = puedeCobrar,
): Promise<{ fila: FilaPin } | { error: string; status: number }> {
  if (!/^\d{6}$/.test(pin)) return { error: 'El PIN es de 6 digitos.', status: 400 };
  const fila = await env.DB.prepare(
    `select correo, nombre, roles, caja, pin_hash, pin_sal, pin_bloqueo from usuarios
     where correo = ? and activo = 1 and pin_hash != ''`,
  )
    .bind(correo)
    .first<FilaPin>();
  if (!fila || !admite(leerRoles(fila.roles))) return { error: 'Sin PIN. Pideselo al dueno.', status: 404 };

  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  const bloqueado = { error: 'PIN bloqueado por intentos fallidos. Espera 15 minutos o llama a Isaac.', status: 423 };
  if (fila.pin_bloqueo > ahoraIso) return bloqueado;

  // El intento se cuenta ANTES de comparar: si se contara despues, una rafaga en
  // paralelo (todas leyeron "sin bloqueo") probaria cientos de PIN por ventana y
  // el 423 delataria el correcto. Asi solo INTENTOS_PIN comparan por ventana.
  const reservado = await env.DB.prepare(
    `update usuarios set pin_fallos = pin_fallos + 1
     where correo = ? and pin_hash = ? and pin_bloqueo <= ? and pin_fallos < ? returning pin_fallos`,
  ).bind(correo, fila.pin_hash, ahoraIso, INTENTOS_PIN).first();
  if (!reservado) {
    // Los intentos ya estan repartidos: se cierra la ventana (tambien repara un contador que quedo en el tope).
    await env.DB.prepare(
      `update usuarios set pin_bloqueo = ?, pin_fallos = 0 where correo = ? and pin_hash = ? and pin_fallos >= ? and pin_bloqueo <= ?`,
    ).bind(new Date(ahora.getTime() + BLOQUEO_PIN).toISOString(), correo, fila.pin_hash, INTENTOS_PIN, ahoraIso).run();
    return bloqueado;
  }

  if (await hashPin(pin, fila.pin_sal) !== fila.pin_hash) {
    // El ultimo intento permitido que falla bloquea; sin tocar un PIN recien cambiado.
    const cierre = await env.DB.prepare(
      `update usuarios set pin_bloqueo = ?, pin_fallos = 0
       where correo = ? and pin_hash = ? and pin_fallos >= ? and pin_bloqueo <= ? returning pin_bloqueo`,
    ).bind(new Date(ahora.getTime() + BLOQUEO_PIN).toISOString(), correo, fila.pin_hash, INTENTOS_PIN, ahoraIso).first();
    return { error: cierre ? 'PIN incorrecto. Se bloqueo 15 minutos.' : 'PIN incorrecto.', status: 403 };
  }

  // Confirmar y limpiar fallos juntos: el PIN o el bloqueo pudieron cambiar durante PBKDF2.
  const autorizado = await env.DB.prepare(
    `update usuarios set pin_fallos = 0 where correo = ? and pin_hash = ? and pin_bloqueo <= ? returning correo`,
  ).bind(correo, fila.pin_hash, ahoraIso).first();
  if (!autorizado) return { error: 'PIN bloqueado o recien cambiado. Intenta otra vez.', status: 423 };
  return { fila };
}

export async function entrar(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as { correo?: unknown; pin?: unknown };
  const correo = String(cuerpo.correo ?? '').trim().toLowerCase();
  const verificado = await verificarPin(env, correo, String(cuerpo.pin ?? ''));
  if ('error' in verificado) return json({ error: verificado.error }, verificado.status);
  const { fila } = verificado;
  const ahora = new Date();
  const ahoraIso = ahora.toISOString();

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
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as { correo?: unknown; pin?: unknown };
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
