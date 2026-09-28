import { hashPin, saldo } from './dolarones.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

type Identidad = { uid: string; telefono: string };
type Cliente = { id: string; numero: number; nombre: string; telefono: string; bases_version: string };

function promocionAbierta(env: Env): boolean {
  const inicio = env.PROMOCION_INICIO;
  return env.PORTAL_REGISTRO_ABIERTO === 'si' && !!env.BASES_APROBADAS_VERSION &&
    !env.BASES_APROBADAS_VERSION.startsWith('borrador') && !!inicio &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(inicio) &&
    Number.isFinite(Date.parse(inicio)) && Date.now() >= Date.parse(inicio);
}

// accounts:lookup valida el ID token contra Firebase y devuelve el registro
// vigente; validSince permite rechazar una sesión revocada en cada petición.
export async function identidad(request: Request, env: Env): Promise<Identidad | null> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(authorization);
  if (!match || !env.FIREBASE_PROJECT_ID || !env.FIREBASE_WEB_API_KEY) return null;
  const token = match[1];
  let claims: Record<string, unknown>;
  try {
    const partes = token.split('.');
    if (partes.length !== 3) return null;
    const header = JSON.parse(atob(partes[0].replace(/-/g, '+').replace(/_/g, '/'))) as { alg?: string };
    claims = JSON.parse(atob(partes[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || claims.aud !== env.FIREBASE_PROJECT_ID ||
      claims.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}` ||
      typeof claims.sub !== 'string' || !claims.sub ||
      typeof claims.exp !== 'number' || claims.exp <= now ||
      typeof claims.iat !== 'number' || claims.iat > now ||
      typeof claims.auth_time !== 'number' || claims.auth_time > now ||
      (claims.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider !== 'phone') return null;
  } catch { return null; }
  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }),
    });
  } catch { return null; }
  if (!response.ok) return null;
  const data = await response.json() as { users?: { localId?: string; phoneNumber?: string; validSince?: string; disabled?: boolean }[] };
  const user = data.users?.[0];
  if (!user || user.disabled || user.localId !== claims.sub ||
    !/^\+52\d{10}$/.test(user.phoneNumber ?? '') ||
    user.phoneNumber !== claims.phone_number ||
    !Number.isFinite(Number(user.validSince)) || Number(user.validSince) > Number(claims.auth_time)) return null;
  return { uid: user.localId, telefono: user.phoneNumber!.slice(3) };
}

async function cliente(env: Env, uid: string): Promise<Cliente | null> {
  return env.DB.prepare('select id, numero, nombre, telefono, bases_version from clientes where auth_uid = ?')
    .bind(uid).first<Cliente>();
}

async function premio(env: Env, canal: 'online' | 'tienda', clienteId: string, ahora: Date, orden?: number): Promise<void> {
  const lote = crypto.randomUUID();
  const iso = ahora.toISOString();
  const vence = new Date(ahora.getTime() + 30 * DIA).toISOString();
  await env.DB.batch([
    env.DB.prepare(`update premios_apertura set cliente_id = ?, lote_id = ? where rowid = (
      select rowid from premios_apertura where canal = ? and cliente_id is null
      and (canal = 'online' or orden > 1 or ? = 1)
      and (? is null or orden = ?) order by orden limit 1
    ) and not exists (select 1 from premios_apertura where cliente_id = ?)`)
      .bind(clienteId, lote, canal, orden ?? null, orden ?? null, orden ?? null, clienteId),
    env.DB.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
      select lote_id, cliente_id, 'regalo', null, importe, importe, ?, ?, ? from premios_apertura where lote_id = ?`)
      .bind(iso, vence, iso, lote),
    env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
      select cliente_id, id, null, 'regalo', importe, 'portal', ? from dolarones_lotes where id = ?`).bind(iso, lote),
  ]);
}

async function premioActual(env: Env, clienteId: string) {
  return env.DB.prepare(`select p.canal, p.orden, p.importe, p.lote_id, l.restante, l.vence_en,
    exists(select 1 from dolarones_movimientos m where m.lote_id = p.lote_id and m.tipo = 'canje') as usado
    from premios_apertura p join dolarones_lotes l on l.id = p.lote_id where p.cliente_id = ?`)
    .bind(clienteId).first<{ canal: string; orden: number; importe: number; lote_id: string; restante: number; vence_en: string; usado: number }>();
}

async function hayRegalosLegados(env: Env): Promise<boolean> {
  return !!await env.DB.prepare(`select 1 from dolarones_lotes l where l.origen = 'regalo'
    and not exists (select 1 from premios_apertura p where p.lote_id = l.id)
    and not exists (select 1 from dolarones_movimientos m where m.lote_id = l.id and m.tipo = 'reemplazo') limit 1`).first();
}

export async function registro(request: Request, env: Env, auth: Identidad): Promise<Response> {
  const ahora = new Date();
  if (!promocionAbierta(env)) return json({ error: 'Registro no disponible.' }, 503);
  if (await hayRegalosLegados(env))
    return json({ error: 'Hay premios anteriores pendientes de conciliación; registro cerrado.' }, 409);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const nombre = String(body.nombre ?? '').replace(/\s+/g, ' ').trim();
  const pin = String(body.pin ?? '');
  if (nombre.length < 2 || nombre.length > 80 || !/^\d{4}$/.test(pin) ||
    body.bases_version !== env.BASES_APROBADAS_VERSION || body.acepta_bases !== true)
    return json({ error: 'Nombre, PIN y aceptación vigente requeridos.' }, 400);
  let socio = await cliente(env, auth.uid);
  if (socio) {
    try {
      await env.DB.prepare(`update clientes set telefono = ?, bases_version = ?,
        bases_aceptadas_en = case when bases_version = ? then bases_aceptadas_en else ? end
        where id = ? and auth_uid = ?`)
        .bind(auth.telefono, env.BASES_APROBADAS_VERSION, env.BASES_APROBADAS_VERSION,
          ahora.toISOString(), socio.id, auth.uid).run();
    } catch { return json({ error: 'El teléfono requiere revisión presencial.' }, 409); }
  } else {
    const id = crypto.randomUUID();
    const sal = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await env.DB.prepare(`insert into clientes
        (id, numero, nombre, telefono, pin_hash, pin_sal, bases_version, bases_aceptadas_en, registrado_por, creado_en, auth_uid)
        select ?, coalesce(max(numero), 0) + 1, ?, ?, ?, ?, ?, ?, 'portal', ?, ? from clientes`)
        .bind(id, nombre, auth.telefono, await hashPin(pin, sal), sal,
          env.BASES_APROBADAS_VERSION, ahora.toISOString(), ahora.toISOString(), auth.uid).run();
    } catch {
      socio = await cliente(env, auth.uid);
      if (!socio) return json({ error: 'El teléfono requiere revisión presencial.' }, 409);
    }
  }
  socio = (await cliente(env, auth.uid))!;
  if (!await premioActual(env, socio.id)) await premio(env, 'online', socio.id, ahora);
  return json({ id: socio.id, numero: socio.numero, nombre: socio.nombre,
    ...(await saldo(env, socio.id, new Date().toISOString())), premio: await premioActual(env, socio.id) }, 200);
}

export async function llegada(request: Request, env: Env, autor: string): Promise<Response> {
  if (!promocionAbierta(env)) return json({ error: 'Promoción no disponible.' }, 503);
  const body = await request.json().catch(() => ({})) as { cliente_id?: unknown };
  const id = String(body.cliente_id ?? '');
  if (!UUID.test(id)) return json({ error: 'Socio inválido.' }, 400);
  if (!await env.DB.prepare('select 1 from clientes where id = ?').bind(id).first()) return json({ error: 'Socio no encontrado.' }, 404);
  if (await hayRegalosLegados(env)) return json({ error: 'Resolver premios anteriores antes de abrir la promoción.' }, 409);
  const ahora = new Date();
  await env.DB.prepare(`insert or ignore into primera_llegada (singleton, cliente_id, acreditado_por, acreditado_en)
    values (1, ?, ?, ?)`).bind(id, autor, ahora.toISOString()).run();
  const primero = await env.DB.prepare('select cliente_id from primera_llegada where singleton = 1').first<{ cliente_id: string }>();
  const actual = await premioActual(env, id);
  if (primero?.cliente_id === id) {
    if (actual?.canal === 'tienda' && actual.orden === 1) return json({ premio: actual });
    if (actual && (actual.canal !== 'online' || actual.restante !== actual.importe || actual.usado || actual.vence_en <= ahora.toISOString()))
      return json({ error: 'Reemplazo pendiente de resolución; premio parcialmente usado o vencido.' }, 409);
    if (actual) {
      const nuevo = crypto.randomUUID();
      const iso = ahora.toISOString();
      await env.DB.batch([
        env.DB.prepare(`update dolarones_lotes set restante = case when restante = importe and vence_en > ?
          and not exists (select 1 from dolarones_movimientos where lote_id = ? and tipo = 'canje')
          then 0 else -1 end where id = ?`).bind(iso, actual.lote_id, actual.lote_id),
        env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, tipo, importe, autor, creado_en)
          values (?, ?, 'reemplazo', ?, ?, ?)`).bind(id, actual.lote_id, -actual.importe, autor, iso),
        env.DB.prepare('update premios_apertura set cliente_id = null, lote_id = null where lote_id = ?')
          .bind(actual.lote_id),
        env.DB.prepare(`update premios_apertura set cliente_id = ?, lote_id = ? where canal = 'tienda' and orden = 1 and cliente_id is null`)
          .bind(id, nuevo),
        env.DB.prepare(`insert into dolarones_lotes (id, cliente_id, origen, importe, restante, disponible_desde, vence_en, creado_en)
          select lote_id, cliente_id, 'regalo', importe, importe, ?, ?, ? from premios_apertura where lote_id = ?`)
          .bind(iso, new Date(ahora.getTime() + 30 * DIA).toISOString(), iso, nuevo),
        env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, tipo, importe, autor, creado_en)
          select cliente_id, id, 'regalo', importe, ?, ? from dolarones_lotes where id = ?`).bind(autor, iso, nuevo),
      ]);
    } else await premio(env, 'tienda', id, ahora, 1);
  } else if (!actual) await premio(env, 'tienda', id, ahora);
  return json({ premio: await premioActual(env, id) });
}

export async function portal(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await identidad(request, env);
  if (!auth) return json({ error: 'Sesión inválida.' }, 401);
  if (url.pathname === '/api/portal/registro' && request.method === 'POST') return registro(request, env, auth);
  const socio = await cliente(env, auth.uid);
  if (!socio) return json({ error: 'Registro requerido.' }, 404);
  if (url.pathname === '/api/portal/yo' && request.method === 'GET')
    return json({ id: socio.id, numero: socio.numero, nombre: socio.nombre, telefono: `+52${socio.telefono}`, bases_version: socio.bases_version });
  if (url.pathname === '/api/portal/saldo' && request.method === 'GET') {
    const s = await saldo(env, socio.id, new Date().toISOString());
    return json({ disponible_compras: s.disponible - s.regalo_disponible,
      regalo_sujeto_minimo: s.regalo_disponible, por_liberar: s.por_liberar, disponible_total: s.disponible });
  }
  if (url.pathname === '/api/portal/recibos' && request.method === 'GET') {
    const pedido = Number(url.searchParams.get('limit') ?? 20);
    if (!Number.isInteger(pedido) || pedido < 1) return json({ error: 'Límite inválido.' }, 400);
    const limit = Math.min(50, pedido);
    const cursor = url.searchParams.get('cursor');
    let desde = ''; let desdeId = '';
    if (cursor) {
      if (cursor.length > 256) return json({ error: 'Cursor inválido.' }, 400);
      try { [desde, desdeId] = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as [string, string]; }
      catch { return json({ error: 'Cursor inválido.' }, 400); }
      if (!/^\d{4}-\d\d-\d\dT/.test(desde) || !UUID.test(desdeId)) return json({ error: 'Cursor inválido.' }, 400);
    }
    const { results } = await env.DB.prepare(`select id, registrado_en, creado_en, total, dolarones, forma_pago, cancelada
      from ventas where cliente_id = ? and (? = '' or registrado_en < ? or (registrado_en = ? and id < ?))
      order by registrado_en desc, id desc limit ?`)
      .bind(socio.id, desde, desde, desde, desdeId, limit + 1).all<{
        id: string; registrado_en: string; creado_en: string; total: number; dolarones: number; forma_pago: string; cancelada: number;
      }>();
    const pagina = results.slice(0, limit);
    const ultimo = pagina.at(-1);
    return json({ recibos: pagina.map((v) => ({ ...v, cancelada: Boolean(v.cancelada), pago_monetario: v.total - v.dolarones })),
      siguiente: results.length > limit && ultimo ? btoa(JSON.stringify([ultimo.registrado_en, ultimo.id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null });
  }
  const match = /^\/api\/portal\/recibos\/([^/]+)$/.exec(url.pathname);
  if (match && request.method === 'GET') {
    if (!UUID.test(match[1])) return json({ error: 'Recibo no encontrado.' }, 404);
    const venta = await env.DB.prepare(`select id, creado_en, registrado_en, total, dolarones, forma_pago, efectivo, cambio,
      cancelada, cancelada_en from ventas where id = ? and cliente_id = ?`).bind(match[1], socio.id).first<{
        id: string; creado_en: string; registrado_en: string; total: number; dolarones: number; forma_pago: string;
        efectivo: number; cambio: number; cancelada: number; cancelada_en: string;
      }>();
    if (!venta) return json({ error: 'Recibo no encontrado.' }, 404);
    const { results: lineas } = await env.DB.prepare('select codigo, nombre, precio, cantidad from venta_lineas where venta_id = ? order by id')
      .bind(venta.id).all();
    const ganado = await env.DB.prepare(`select coalesce(sum(importe), 0) as importe from dolarones_lotes
      where venta_id = ? and origen = 'compra'`).bind(venta.id).first<{ importe: number }>();
    return json({ ...venta, cancelada: Boolean(venta.cancelada), pago_monetario: venta.total - venta.dolarones,
      d_usados: venta.dolarones, d_ganados: ganado?.importe ?? 0, lineas, tipo: 'recibo_de_compra_no_factura' });
  }
  return json({ error: 'Ruta no encontrada.' }, 404);
}
