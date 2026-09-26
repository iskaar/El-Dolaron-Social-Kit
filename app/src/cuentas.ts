/**
 * Centro de cuentas (Issue #75). Cloudflare Access (con Google) dice QUIEN es
 * la persona; la tabla `usuarios` dice si entra y QUE puede hacer.
 *
 * Antes el Worker leia el correo del encabezado `cf-access-authenticated-user-email`
 * y le creia. Con roles de por medio eso no alcanza: aqui se verifica la firma
 * del JWT que Access le pega a cada peticion, contra las llaves publicas del
 * equipo de Zero Trust.
 */

export type Rol = 'dueno' | 'cajero' | 'capturista';
export const ROLES: readonly Rol[] = ['dueno', 'cajero', 'capturista'];
/** Lo que recibe alguien al aprobarle el acceso si no se escoge otra cosa. */
export const ROL_POR_OMISION: Rol = 'cajero';

export interface Usuario {
  correo: string;
  nombre: string;
  roles: Rol[];
  activo: boolean;
}

interface FilaUsuario {
  correo: string;
  nombre: string;
  roles: string;
  activo: number;
}

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
const CAJA: Rol[] = ['cajero'];
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
  '/tarjeta-bandas': TODOS,
  '/reportes': DUENO,
  '/cuentas': DUENO,
};

export function permiso(pathname: string, metodo: string): Regla {
  const ruta = pathname.replace(/\.html$/, '').replace(/(.)\/$/, '$1');

  if (ruta === '/api/salud') return 'libre';
  if (ruta === '/sin-acceso' || ruta === '/api/yo') return 'cuenta';
  if (ruta === '/api/solicitudes/acceso' && metodo === 'POST') return 'cuenta';
  // Codigo de las pantallas, sin datos: el permiso se cobra en la pantalla y en la API.
  if (!ruta.startsWith('/api/') && /\.(js|css|png|svg|ico)$/.test(ruta)) return 'cuenta';

  if (ruta in PANTALLAS) return PANTALLAS[ruta];

  if (ruta === '/api/config') return metodo === 'GET' ? CAPTURA : DUENO;
  if (ruta === '/api/familias') return metodo === 'GET' ? TODOS : DUENO;
  if (ruta === '/api/borradores' || ruta.startsWith('/api/borradores/')) return CAPTURA;
  if (ruta.startsWith('/api/foto/')) return CAPTURA;
  if (ruta === '/api/etiquetas') return CAPTURA;
  if (ruta === '/api/catalogo') return CAJA;
  // ponytail: cancelar sigue abierto al cajero hasta la fase 2 del Issue #75,
  // que lo pasa por una solicitud aprobada por el dueno.
  if (ruta === '/api/ventas' || ruta.startsWith('/api/ventas/')) return CAJA;

  return DUENO;
}

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
  const fila = await env.DB.prepare('select correo, nombre, roles, activo from usuarios where correo = ?')
    .bind(correo)
    .first<FilaUsuario>();
  return fila ? { correo: fila.correo, nombre: fila.nombre, roles: leerRoles(fila.roles), activo: fila.activo === 1 } : null;
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Quien soy y que puedo hacer: para la pantalla de sin acceso y para esconder lo que no toca. */
export async function yo(env: Env, correo: string): Promise<Response> {
  const usuario = await leerUsuario(env, correo);
  const solicitud = await env.DB.prepare(
    `select estado, creado_en from solicitudes where tipo = 'acceso' and correo = ?
     order by creado_en desc limit 1`,
  )
    .bind(correo)
    .first<{ estado: string; creado_en: string }>();
  return json({ correo, usuario, solicitud });
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
    'select correo, nombre, roles, activo, creado_en from usuarios order by activo desc, nombre',
  ).all<FilaUsuario & { creado_en: string }>();
  const { results: solicitudes } = await env.DB.prepare(
    `select id, tipo, correo, nombre, justificacion, datos, creado_en from solicitudes
     where estado = 'pendiente' order by creado_en`,
  ).all();
  const usuarios = filas.map((f) => ({ ...f, roles: leerRoles(f.roles), activo: f.activo === 1 }));
  return json({ usuarios, solicitudes, roles: ROLES });
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: 'Correo invalido.' }, 400);
  if (!roles) return json({ error: 'Escoge al menos un rol.' }, 400);
  if (await quedariaSinDueno(env, correo, roles, activo)) {
    return json({ error: 'Tiene que quedar al menos un dueno activo.' }, 400);
  }
  const ahora = new Date().toISOString();
  await env.DB.prepare(
    `insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, ?, ?, ?)
     on conflict (correo) do update set nombre = excluded.nombre, roles = excluded.roles,
       activo = excluded.activo, actualizado_en = excluded.actualizado_en`,
  )
    .bind(correo, nombre, roles.join(','), activo ? 1 : 0, ahora, ahora)
    .run();
  return json({ correo, nombre, roles, activo });
}

/** Aprobar o rechazar una solicitud. Hoy solo las de acceso (fase 1 del Issue #75). */
export async function resolverSolicitud(id: string, request: Request, env: Env, dueno: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { aprobar?: unknown; roles?: unknown };
  const solicitud = await env.DB.prepare(
    `select id, tipo, correo, nombre, estado from solicitudes where id = ?`,
  )
    .bind(id)
    .first<{ id: string; tipo: string; correo: string; nombre: string; estado: string }>();
  if (!solicitud) return json({ error: 'La solicitud no existe.' }, 404);
  if (solicitud.estado !== 'pendiente') return json({ error: `Ya estaba ${solicitud.estado}.` }, 409);
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
