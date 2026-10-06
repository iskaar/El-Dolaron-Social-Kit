import { resolverCancelacion } from './cancelaciones.ts';

/**
 * Centro de cuentas (Issue #75). Cloudflare Access (con Google) dice QUIEN es
 * la persona; la tabla `usuarios` dice si entra y QUE puede hacer.
 *
 * Antes el Worker leia el correo del encabezado `cf-access-authenticated-user-email`
 * y le creia. Con roles de por medio eso no alcanza: aqui se verifica la firma
 * del JWT que Access le pega a cada peticion, contra las llaves publicas del
 * equipo de Zero Trust.
 */

// `computadora`: la cuenta de la tienda con la que entra la computadora de caja;
// sola no cobra, cada cajero entra con su PIN (Issue #112, cajeros.ts).
export type Rol = 'dueno' | 'cajero' | 'capturista' | 'computadora';
export const ROLES: readonly Rol[] = ['dueno', 'cajero', 'capturista', 'computadora'];
/** Lo que recibe alguien al aprobarle el acceso si no se escoge otra cosa. */
export const ROL_POR_OMISION: Rol = 'cajero';

export interface Usuario {
  correo: string;
  nombre: string;
  roles: Rol[];
  activo: boolean;
  caja: string;   // la caja del cajero (Issue #105); '' = la de la computadora
}

interface FilaUsuario {
  correo: string;
  nombre: string;
  roles: string;
  activo: number;
  caja: string;
}

/** Las cajas que se pueden asignar; las mismas que ofrece /caja. */
export const CAJAS = ['Caja 1', 'Caja 2', 'Caja 3'];

/* ---------- permisos por ruta ---------- */

/**
 * 'libre': sin sesion (la sonda de salud). 'cuenta': cualquiera que ya paso
 * por Access, tenga cuenta o no (la pantalla para pedir acceso). Una lista:
 * esos roles. El dueno entra a todo, asi que nunca hace falta listarlo; una
 * lista vacia es "solo el dueno".
 *
 * Lo que no esta aqui es solo del dueno: una pantalla nueva nace cerrada.
 */
export type Regla = 'libre' | 'cuenta' | Rol[];

const CAPTURA: Rol[] = ['capturista'];
const CAJA: Rol[] = ['cajero', 'computadora'];
const TODOS: Rol[] = ['cajero', 'capturista'];
const DUENO: Rol[] = [];

const PANTALLAS: Record<string, Rol[]> = {
  '/': TODOS,
  '/index': TODOS,
  '/captura': CAPTURA,
  '/admin': CAPTURA,
  '/etiquetas': CAPTURA,
  '/bandas': CAPTURA,
  '/calibrar-etiqueta': CAPTURA,
  '/prueba-codigo': CAPTURA,
  '/sonda-impresora': CAPTURA,
  '/caja': CAJA,
  '/socios': CAJA,
  '/tarjeta-bandas': TODOS,
  '/reportes': DUENO,
  '/mercadolibre': DUENO,
  '/cuentas': DUENO,
};

export function permiso(pathname: string, metodo: string): Regla {
  const ruta = pathname.replace(/\.html$/, '').replace(/(.)\/$/, '$1');

  if (ruta === '/api/salud') return 'libre';
  // Lo llama Mercado Libre, sin sesion: lo protege la ruta secreta (mercadolibre.ts).
  if (metodo === 'POST' && /^\/api\/ml\/notificaciones\/[^/]+$/.test(ruta)) return 'libre';
  if (ruta === '/sin-acceso' || ruta === '/api/yo') return 'cuenta';
  if (ruta === '/api/solicitudes/acceso' && metodo === 'POST') return 'cuenta';
  // Codigo de las pantallas, sin datos: el permiso se cobra en la pantalla y en la API.
  if (!ruta.startsWith('/api/') && /\.(js|css|png|svg|ico)$/.test(ruta)) return 'cuenta';

  if (ruta in PANTALLAS) return PANTALLAS[ruta];

  if (ruta === '/api/config') return metodo === 'GET' ? CAPTURA : DUENO;
  if (ruta === '/api/familias') return metodo === 'GET' ? TODOS : DUENO;
  if (ruta === '/api/borradores/manual') return DUENO;   // captura sin foto (Issue #115)
  if (ruta === '/api/borradores' || ruta.startsWith('/api/borradores/')) return CAPTURA;
  if (ruta.startsWith('/api/foto/')) return CAPTURA;
  if (ruta === '/api/etiquetas') return CAPTURA;
  if (ruta === '/api/calibracion') return CAPTURA;
  if (ruta === '/api/catalogo') return CAJA;
  if (ruta === '/api/socios') return CAJA;
  if (ruta === '/api/vales/config' && metodo === 'GET') return CAJA;
  if (ruta === '/api/vales/buscar' && metodo === 'POST') return CAJA;
  if (ruta === '/api/socios/codigo' && metodo === 'POST') return CAJA;
  if (ruta === '/api/socios/legal' && metodo === 'GET') return CAJA;
  if (ruta === '/api/portal/llegada' && metodo === 'POST') return CAJA;
  if (ruta === '/api/cajon') return CAJA;
  if (ruta === '/api/cortes' || ruta === '/api/retiros') return CAJA;
  if (ruta === '/api/cajeros' || ruta === '/api/cajeros/entrar' || ruta === '/api/cajeros/salir') return CAJA;
  // Cancelar una venta completa: el cajero solo en los primeros minutos; despues
  // pide aprobacion del dueno (Issue #200, cancelaciones.ts).
  if (ruta === '/api/solicitudes/cancelaciones') return DUENO;
  if (/^\/api\/solicitudes\/[^/]+$/.test(ruta) && metodo === 'GET') return CAJA;   // la caja ve como va la suya
  if (ruta === '/api/ventas' || ruta.startsWith('/api/ventas/')) return CAJA;
  if (ruta === '/api/impresiones' || ruta.startsWith('/api/impresiones/')) return CAJA;

  return DUENO;
}

/** Lo de caja: lo unico que abre el PIN del cajero. */
export const esDeCaja = (regla: Regla) => regla === CAJA;

/** La cuenta de la computadora de caja: para cobrar necesita el PIN de un cajero. */
export const soloComputadora = (usuario: Usuario | null) =>
  !!usuario?.roles.includes('computadora') && !usuario.roles.includes('cajero') && !usuario.roles.includes('dueno');

export function puede(usuario: Usuario | null, regla: Regla): boolean {
  if (regla === 'libre' || regla === 'cuenta') return true;
  if (!usuario?.activo) return false;
  return usuario.roles.includes('dueno') || regla.some((rol) => usuario.roles.includes(rol));
}

/* ---------- quien es ---------- */

const decodificar = (b64url: string): Uint8Array => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const comoJson = (b64url: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(decodificar(b64url)));

/**
 * El correo dentro de un JWT de Access, o null si no es valido: firma RS256 de
 * una llave del equipo, para ESTA aplicacion (aud), del equipo correcto (iss) y
 * vigente. Exportada para probarla con llaves generadas en la prueba.
 */
export async function verificarJwt(
  token: string,
  aud: string,
  emisor: string,
  llave: (kid: string) => Promise<CryptoKey | undefined>,
  ahora = Date.now() / 1000,
): Promise<string | null> {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  let cabecera: Record<string, unknown>;
  let carga: Record<string, unknown>;
  try {
    cabecera = comoJson(partes[0]);
    carga = comoJson(partes[1]);
  } catch {
    return null;
  }
  if (cabecera.alg !== 'RS256' || typeof cabecera.kid !== 'string') return null;
  const clave = await llave(cabecera.kid);
  if (!clave) return null;
  const firmada = new TextEncoder().encode(`${partes[0]}.${partes[1]}`);
  let valida = false;
  try {
    valida = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', clave, decodificar(partes[2]), firmada);
  } catch {
    return null;
  }
  if (!valida) return null;

  const auds = Array.isArray(carga.aud) ? carga.aud : [carga.aud];
  if (!auds.includes(aud) || carga.iss !== emisor) return null;
  if (typeof carga.exp !== 'number' || carga.exp < ahora) return null;
  if (typeof carga.nbf === 'number' && carga.nbf > ahora + 60) return null;
  if (typeof carga.email !== 'string' || !carga.email) return null;
  return carga.email.toLowerCase();
}

// Las llaves publicas de Access rotan de vez en cuando: se guardan una hora, y
// un kid desconocido las vuelve a pedir (como mucho cada 5 minutos, para que un
// token inventado no ponga a pedir llaves en cada peticion).
let llaves: { pedidas: number; porKid: Map<string, CryptoKey> } | null = null;

async function llaveDeAccess(equipo: string, kid: string): Promise<CryptoKey | undefined> {
  const edad = llaves ? Date.now() - llaves.pedidas : Infinity;
  if (edad > 3600_000 || (!llaves?.porKid.has(kid) && edad > 300_000)) {
    const respuesta = await fetch(`https://${equipo}/cdn-cgi/access/certs`);
    if (!respuesta.ok) return llaves?.porKid.get(kid);
    const { keys } = (await respuesta.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const porKid = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      porKid.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      ));
    }
    llaves = { pedidas: Date.now(), porKid };
  }
  return llaves?.porKid.get(kid);
}

/**
 * El correo verificado de quien hace la peticion, o null.
 *
 * Con ACCESS_EQUIPO = "local" (solo `wrangler dev --var ACCESS_EQUIPO:local
 * --var DEV_USUARIO:<correo>`) se entra como DEV_USUARIO, sin Access. En
 * produccion ACCESS_EQUIPO es el equipo real de wrangler.jsonc; y si faltara,
 * nadie entra: cerrado por omision.
 */
export async function quienEs(request: Request, env: Env, hostname: string): Promise<string | null> {
  const equipo: string | undefined = env.ACCESS_EQUIPO;
  if (equipo === 'local') return env.DEV_USUARIO?.toLowerCase() || null;
  const aud = (env.ACCESS_AUD as Record<string, string> | undefined)?.[hostname];
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!equipo || !aud || !token) return null;
  return verificarJwt(token, aud, `https://${equipo}`, (kid) => llaveDeAccess(equipo, kid));
}

/* ---------- usuarios ---------- */

export const leerRoles = (texto: string): Rol[] =>
  texto.split(',').map((r) => r.trim()).filter((r): r is Rol => (ROLES as string[]).includes(r));

export async function leerUsuario(env: Env, correo: string): Promise<Usuario | null> {
  const fila = await env.DB.prepare('select correo, nombre, roles, activo, caja from usuarios where correo = ?')
    .bind(correo)
    .first<FilaUsuario>();
  return fila
    ? { correo: fila.correo, nombre: fila.nombre, roles: leerRoles(fila.roles), activo: fila.activo === 1, caja: fila.caja }
    : null;
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Quien soy y que puedo hacer: para la pantalla de sin acceso y para esconder lo que no toca. */
export async function yo(env: Env, correo: string, cajero: Usuario | null = null): Promise<Response> {
  const usuario = await leerUsuario(env, correo);
  const solicitud = await env.DB.prepare(
    `select estado, creado_en from solicitudes where tipo = 'acceso' and correo = ?
     order by creado_en desc limit 1`,
  )
    .bind(correo)
    .first<{ estado: string; creado_en: string }>();
  return json({ correo, usuario, solicitud, cajero: cajero && { correo: cajero.correo, nombre: cajero.nombre, caja: cajero.caja } });
}

/** Alguien sin cuenta pide entrar. Una sola pendiente por persona: pedir otra vez la actualiza. */
export async function pedirAcceso(request: Request, env: Env, correo: string): Promise<Response> {
  const usuario = await leerUsuario(env, correo);
  if (usuario?.activo) return json({ error: 'Ya tienes cuenta.' }, 409);
  const cuerpo = (await request.json().catch(() => ({}))) as { nombre?: unknown; justificacion?: unknown };
  const nombre = texto(cuerpo.nombre, 80);
  const justificacion = texto(cuerpo.justificacion, 500);
  if (!nombre || !justificacion) {
    return json({ error: 'Escribe tu nombre y para que necesitas entrar.' }, 400);
  }
  const ahora = new Date().toISOString();
  const pendiente = await env.DB.prepare(
    `select id from solicitudes where tipo = 'acceso' and correo = ? and estado = 'pendiente'`,
  )
    .bind(correo)
    .first<{ id: string }>();
  if (pendiente) {
    await env.DB.prepare('update solicitudes set nombre = ?, justificacion = ?, creado_en = ? where id = ?')
      .bind(nombre, justificacion, ahora, pendiente.id)
      .run();
    return json({ id: pendiente.id, estado: 'pendiente' });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into solicitudes (id, tipo, correo, nombre, justificacion, creado_en) values (?, 'acceso', ?, ?, ?, ?)`,
  )
    .bind(id, correo, nombre, justificacion, ahora)
    .run();
  return json({ id, estado: 'pendiente' }, 201);
}

/** Para /cuentas: todos los usuarios y lo que esta esperando respuesta. */
export async function listarCuentas(env: Env): Promise<Response> {
  const { results: filas } = await env.DB.prepare(
    `select correo, nombre, roles, activo, caja, pin_hash != '' as tiene_pin, creado_en from usuarios
     order by activo desc, nombre`,
  ).all<FilaUsuario & { creado_en: string; tiene_pin: number }>();
  const { results: solicitudes } = await env.DB.prepare(
    `select id, tipo, correo, nombre, justificacion, datos, creado_en from solicitudes
     where estado = 'pendiente' order by creado_en`,
  ).all();
  const usuarios = filas.map((f) => ({ ...f, roles: leerRoles(f.roles), activo: f.activo === 1, tiene_pin: f.tiene_pin === 1 }));
  return json({ usuarios, solicitudes, roles: ROLES, cajas: CAJAS });
}

/**
 * Nunca se queda la tienda sin dueno activo: quitarse el rol o desactivarse a
 * uno mismo siendo el ultimo dejaria a todos sin poder aprobar a nadie.
 */
async function quedariaSinDueno(env: Env, correo: string, roles: Rol[], activo: boolean): Promise<boolean> {
  if (activo && roles.includes('dueno')) return false;
  const { results } = await env.DB.prepare(
    `select correo from usuarios where activo = 1 and (',' || roles || ',') like '%,dueno,%'`,
  ).all<{ correo: string }>();
  return results.every((r) => r.correo === correo);
}

function validarRoles(crudo: unknown): Rol[] | null {
  if (!Array.isArray(crudo)) return null;
  const roles = [...new Set(crudo.map(String))];
  if (roles.length === 0 || !roles.every((r) => (ROLES as string[]).includes(r))) return null;
  return roles as Rol[];
}

/** Alta o cambio de una cuenta desde /cuentas. */
export async function guardarCuenta(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const correo = texto(cuerpo.correo, 200).toLowerCase();
  const nombre = texto(cuerpo.nombre, 80);
  const roles = validarRoles(cuerpo.roles);
  const activo = cuerpo.activo !== false;
  // Sin `caja` en el cuerpo (el alta, o una version vieja de /cuentas) no se toca la que tenga.
  const caja = cuerpo.caja === undefined ? null : String(cuerpo.caja);
  if (caja !== null && caja !== '' && !CAJAS.includes(caja)) return json({ error: 'Caja invalida.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: 'Correo invalido.' }, 400);
  if (!roles) return json({ error: 'Escoge al menos un rol.' }, 400);
  if (await quedariaSinDueno(env, correo, roles, activo)) {
    return json({ error: 'Tiene que quedar al menos un dueno activo.' }, 400);
  }
  const ahora = new Date().toISOString();
  await env.DB.prepare(
    `insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
     values (?, ?, ?, ?, coalesce(?, ''), ?, ?)
     on conflict (correo) do update set nombre = excluded.nombre, roles = excluded.roles,
       activo = excluded.activo, caja = coalesce(?, usuarios.caja), actualizado_en = excluded.actualizado_en`,
  )
    .bind(correo, nombre, roles.join(','), activo ? 1 : 0, caja, ahora, ahora, caja)
    .run();
  const guardado = await leerUsuario(env, correo);
  return json({ correo, nombre, roles, activo, caja: guardado?.caja ?? '' });
}

/** Aprobar o rechazar una solicitud: de acceso (Issue #75) o de cancelacion (Issue #200). */
export async function resolverSolicitud(id: string, request: Request, env: Env, dueno: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { aprobar?: unknown; roles?: unknown };
  const solicitud = await env.DB.prepare(
    `select id, tipo, correo, nombre, estado from solicitudes where id = ?`,
  )
    .bind(id)
    .first<{ id: string; tipo: string; correo: string; nombre: string; estado: string }>();
  if (!solicitud) return json({ error: 'La solicitud no existe.' }, 404);
  if (solicitud.estado !== 'pendiente') return json({ error: `Ya estaba ${solicitud.estado}.` }, 409);
  if (solicitud.tipo === 'cancelacion') return resolverCancelacion(env, id, cuerpo.aprobar === true, dueno);
  if (solicitud.tipo !== 'acceso') return json({ error: 'Tipo de solicitud desconocido.' }, 400);

  const aprobar = cuerpo.aprobar === true;
  const ahora = new Date().toISOString();
  const marcar = env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(aprobar ? 'aprobada' : 'rechazada', ahora, dueno, id);

  if (!aprobar) {
    await marcar.run();
    return json({ id, estado: 'rechazada' });
  }
  const roles = cuerpo.roles === undefined ? [ROL_POR_OMISION] : validarRoles(cuerpo.roles);
  if (!roles) return json({ error: 'Escoge al menos un rol.' }, 400);
  await env.DB.batch([
    marcar,
    env.DB.prepare(
      `insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, ?, ?)
       on conflict (correo) do update set roles = excluded.roles, activo = 1, actualizado_en = excluded.actualizado_en`,
    ).bind(solicitud.correo, solicitud.nombre, roles.join(','), ahora, ahora),
  ]);
  return json({ id, estado: 'aprobada', correo: solicitud.correo, roles });
}
