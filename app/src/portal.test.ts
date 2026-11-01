import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { readFileSync } from 'node:fs';
import { vencerPedidos } from './pedidos.ts';
import { viernesDeEnvio } from '../public/venta.js';

const codificar = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = (uid: string, phone: string, extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return `${codificar({ alg: 'RS256' })}.${codificar({
    aud: 'prueba-firebase', iss: 'https://securetoken.google.com/prueba-firebase', sub: uid,
    exp: now + 3600, iat: now, auth_time: now, phone_number: phone,
    firebase: { sign_in_provider: 'phone' }, ...extra,
  })}.firma`;
};

function portalDePrueba() {
  const { db, env, pedir } = tienda();
  env.HOST_PORTAL = 'portal.prueba';
  env.FIREBASE_PROJECT_ID = 'prueba-firebase';
  env.FIREBASE_WEB_API_KEY = 'clave-de-prueba';
  const fetchOriginal = globalThis.fetch;
  // Como Google: una cuenta nunca revocada no trae validSince.
  let validSince: number | undefined;
  globalThis.fetch = async (_url, options) => {
    const t = JSON.parse(String(options?.body ?? '{}')).idToken as string;
    const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) as { sub: string; phone_number: string };
    return Response.json({ users: [{ localId: claims.sub, phoneNumber: claims.phone_number, ...(validSince === undefined ? {} : { validSince: String(validSince) }) }] });
  };
  // Lo que la app deja para despues de responder (avisos): `esperar()` lo termina.
  const pendientes: Promise<unknown>[] = [];
  const llamar = async (ruta: string, auth: string, body?: unknown, method = 'GET') => {
    const response = await worker.fetch!(new Request(`https://portal.prueba${ruta}`, {
      method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never, env, { waitUntil: (x: Promise<unknown>) => { pendientes.push(x); } } as never);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const registrar = (uid: string, phone: string) => llamar('/api/portal/registro', token(uid, phone), {
    nombre: 'Cliente', acepta_bases: true, declara_mayor_edad:true, bases_version: 'prueba-1',
  }, 'POST');
  const esperar = async () => { await Promise.allSettled(pendientes.splice(0)); };
  return { db, env, pedir, llamar, registrar, esperar, setValidSince: (v: number | undefined) => { validSince = v; },
    cerrar: () => { globalThis.fetch = fetchOriginal; db.close(); } };
}

test('portal cerrado por defecto, host público aislado, token/proyecto/revocación y teléfono canónico', async () => {
  const p = portalDePrueba();
  try {
    assert.equal((await p.llamar('/api/socios', token('a', '+524441112222'))).status, 404);
    assert.equal((await p.llamar('/admin', token('a', '+524441112222'))).status, 404);
    assert.equal((await p.llamar('/api/portal/llegada', token('a', '+524441112222'))).status, 404);
    assert.equal((await p.llamar('/api/portal/yo', token('a', '+524441112222', { aud: 'otro' }))).status, 401);
    assert.equal((await p.llamar('/api/portal/yo', token('a', '+14441112222'))).status, 401);
    p.setValidSince(Math.floor(Date.now() / 1000) + 1);
    assert.equal((await p.llamar('/api/portal/yo', token('a', '+524441112222'))).status, 401);
    p.setValidSince(0);
    p.env.PORTAL_REGISTRO_ABIERTO = '';
    assert.equal((await p.registrar('a', '+524441112222')).status, 503);
    p.env.PORTAL_REGISTRO_ABIERTO = 'si';
    p.env.BASES_APROBADAS_VERSION = 'borrador-2026';
    assert.equal((await p.registrar('a', '+524441112222')).status, 503);
  } finally { p.cerrar(); }
});

test('sólo el UID titular consulta saldo y recibos; teléfono duplicado no enlaza al socio', async () => {
  const p = portalDePrueba();
  try {
    const a = await p.registrar('uid-a', '+524441112222');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((await p.registrar('uid-a', '+524441112222')).body.numero, a.body.numero);
    assert.equal((await p.registrar('uid-b', '+524441112222')).status, 409);
    const b = await p.registrar('uid-b', '+524443334444');
    assert.equal(b.status, 200);
    assert.equal((await p.llamar('/api/portal/saldo', token('uid-a', '+524441112222'))).body.regalo_sujeto_minimo, 300_00);
    const venta = await p.pedir('/api/ventas', {
      id: crypto.randomUUID(), cliente_id: a.body.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 25000,
    });
    assert.equal(venta.status, 201);
    p.db.prepare('update productos set precio = 30000 where id = ?').run(PRODUCTO);
    const segunda = await p.pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: a.body.id,
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'tarjeta', efectivo: 0 });
    assert.equal(segunda.status, 201);
    assert.equal((await p.pedir(`/api/ventas/${segunda.cuerpo.id}/cancelar`, { motivo: 'prueba' })).status, 200);
    const historialA = await p.llamar('/api/portal/recibos?limit=1', token('uid-a', '+524441112222'));
    const historialB = await p.llamar('/api/portal/recibos', token('uid-b', '+524443334444'));
    assert.equal(historialA.body.recibos.length, 1);
    assert.ok(historialA.body.siguiente);
    const pagina2 = await p.llamar(`/api/portal/recibos?limit=1&cursor=${historialA.body.siguiente}`, token('uid-a', '+524441112222'));
    assert.equal(pagina2.body.recibos.length, 1);
    assert.notEqual(historialA.body.recibos[0].id, pagina2.body.recibos[0].id);
    assert.equal(historialB.body.recibos.length, 0);
    assert.equal((await p.llamar(`/api/portal/recibos/${venta.cuerpo.id}`, token('uid-b', '+524443334444'))).status, 404);
    const detalle = await p.llamar(`/api/portal/recibos/${venta.cuerpo.id}`, token('uid-a', '+524441112222'));
    assert.equal(detalle.body.lineas[0].precio, 25000);
    assert.equal(detalle.body.pago_monetario, 25000);
    assert.equal(detalle.body.d_ganados, 2000);
    assert.equal(detalle.body.tipo, 'recibo_de_compra_no_factura');
    assert.equal((await p.llamar(`/api/portal/recibos/${segunda.cuerpo.id}`, token('uid-a', '+524441112222'))).body.cancelada, true);
  } finally { p.cerrar(); }
});

test('registro web requiere declaración adulta y conserva versión y hora del consentimiento', async () => {
  const p = portalDePrueba();
  try {
    const auth = token('uid-adulto', '+524441234567');
    const body = { nombre:'Cliente', acepta_bases:true, bases_version:'prueba-1' };
    assert.equal((await p.llamar('/api/portal/registro', auth, body, 'POST')).status, 400);
    assert.equal((await p.llamar('/api/portal/registro', auth,
      { ...body, declara_mayor_edad:false }, 'POST')).status, 400);
    assert.equal((await p.llamar('/api/portal/registro', auth,
      { ...body, declara_mayor_edad:true }, 'POST')).status, 200);
    const primera = p.db.prepare('select bases_version, bases_aceptadas_en from clientes where auth_uid=?').get('uid-adulto')!;
    assert.equal(primera.bases_version, 'prueba-1');
    assert.ok(Date.parse(String(primera.bases_aceptadas_en)) > 0);
    assert.equal((await p.llamar('/api/portal/registro', auth,
      { ...body, declara_mayor_edad:true }, 'POST')).status, 200);
    assert.equal(p.db.prepare('select bases_aceptadas_en from clientes where auth_uid=?').get('uid-adulto')!.bases_aceptadas_en,
      primera.bases_aceptadas_en);
  } finally { p.cerrar(); }
});

test('cupos 50/50, reemplazo atómico, cupo online recuperado y presupuesto', async () => {
  const p = portalDePrueba();
  try {
    const online = await p.registrar('uid-0', '+524440000000');
    assert.equal(online.body.premio.importe, 300_00);
    const first = await p.pedir('/api/portal/llegada', { cliente_id: online.body.id });
    assert.equal(first.cuerpo.premio.importe, 500_00);
    assert.equal((await p.pedir('/api/portal/llegada', { cliente_id: online.body.id })).cuerpo.premio.importe, 500_00);
    const next = await p.registrar('uid-1', '+524440000001');
    assert.equal(next.body.premio.importe, 300_00); // cupo online devuelto
    for (let n = 2; n <= 50; n++) await p.registrar(`uid-${n}`, `+52444${String(n).padStart(7, '0')}`);
    assert.equal((await p.registrar('uid-51', '+524440000051')).body.premio, null);
    p.db.prepare("update dolarones_lotes set vence_en = '2020-01-01T00:00:00.000Z' where id = (select lote_id from premios_apertura where canal = 'online' and orden = 2)").run();
    assert.equal((await p.registrar('uid-52', '+524440000052')).body.premio, null);
    for (let n = 1; n <= 50; n++) {
      const staff = await p.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente',
        telefono: `555${String(n).padStart(7, '0')}`, pin: '1234', acepta_bases: true, declara_mayor_edad:true });
      assert.equal(staff.status, 201);
      const arrival = await p.pedir('/api/portal/llegada', { cliente_id: staff.cuerpo.id });
      assert.equal(arrival.cuerpo.premio === null, n === 50);
    }
    const sums = p.db.prepare('select canal, count(cliente_id) as n, sum(importe) as total from premios_apertura group by canal order by canal').all() as { canal: string; n: number; total: number }[];
    assert.deepEqual(sums.map((s) => ({ ...s })), [{ canal: 'online', n: 50, total: 730000 }, { canal: 'tienda', n: 50, total: 770000 }]);
    assert.equal(p.db.prepare("select sum(importe) as n from dolarones_lotes where origen='regalo'").get()!.n, 15_000_00 + 300_00);
    assert.equal(p.db.prepare("select sum(importe) as n from dolarones_movimientos where tipo in ('regalo','reemplazo')").get()!.n, 15_000_00);
  } finally { p.cerrar(); }
});

test('la primera llegada con premio parcialmente usado queda reservada para resolución', async () => {
  const p = portalDePrueba();
  try {
    const online = await p.registrar('primera', '+524441234567');
    p.db.prepare('update productos set precio = 100000 where id = ?').run(PRODUCTO);
    const codigo = await p.llamar('/api/portal/codigo', token('primera', '+524441234567'), { maximo:10000 }, 'POST');
    const venta = await p.pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: online.body.id,
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 90000,
      dolarones: 10000, codigo_socio:codigo.body.codigo });
    assert.equal(venta.status, 201);
    assert.equal((await p.pedir('/api/portal/llegada', { cliente_id: online.body.id })).status, 409);
    const segundo = await p.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Otro',
      telefono: '5552223333', pin: '1234', acepta_bases: true, declara_mayor_edad:true });
    assert.equal((await p.pedir('/api/portal/llegada', { cliente_id: segundo.cuerpo.id })).cuerpo.premio.importe, 300_00);
    assert.equal(p.db.prepare("select count(*) as n from premios_apertura where canal='tienda' and orden=1 and cliente_id is not null").get()!.n, 0);
  } finally { p.cerrar(); }
});

test('altas online simultáneas no duplican cupo ni superan 7,300 D', async () => {
  const p = portalDePrueba();
  try {
    const altas = await Promise.all(Array.from({ length: 60 }, (_, n) =>
      p.registrar(`sim-${n}`, `+52666${String(n).padStart(7, '0')}`)));
    assert.equal(altas.filter((r) => r.status === 200).length, 60);
    assert.equal(altas.filter((r) => r.body.premio).length, 50);
    assert.equal(p.db.prepare("select count(*) as n from premios_apertura where canal='online' and cliente_id is not null").get()!.n, 50);
    assert.equal(p.db.prepare("select sum(importe) as n from dolarones_lotes where origen='regalo'").get()!.n, 7_300_00);
  } finally { p.cerrar(); }
});

test('un regalo del esquema anterior cierra el alta antes de crear socio o cupo', async () => {
  const p = portalDePrueba();
  try {
    const anterior = await p.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Anterior',
      telefono: '5551112222', pin: '1234', acepta_bases: true, declara_mayor_edad:true });
    assert.equal(anterior.status, 201);
    p.db.prepare(`insert into dolarones_lotes
      (id, cliente_id, origen, importe, restante, disponible_desde, vence_en, creado_en)
      values (?, ?, 'regalo', 50000, 50000, ?, ?, ?)`).run(crypto.randomUUID(), anterior.cuerpo.id,
        '2026-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    const registro = await p.registrar('nuevo', '+524449998888');
    assert.equal(registro.status, 409);
    assert.match(registro.body.error, /conciliación/);
    assert.equal(p.db.prepare("select count(*) as n from clientes where auth_uid = 'nuevo'").get()!.n, 0);
    assert.equal((await p.pedir('/api/portal/llegada', { cliente_id: anterior.cuerpo.id })).status, 409);
    assert.equal(p.db.prepare('select count(cliente_id) as n from premios_apertura').get()!.n, 0);
  } finally { p.cerrar(); }
});

test('allowlist pública sirve sólo portal y assets necesarios; no abre caja, archivos ni APIs de personal', async () => {
  const p = portalDePrueba();
  try {
    const leidos: string[] = [];
    p.env.ASSETS = { async fetch(request: Request) {
      const ruta = new URL(request.url).pathname;
      leidos.push(ruta);
      return new Response(readFileSync('public/' + (ruta === '/portal' ? 'portal.html' : ruta === '/manual' ? 'manual.html' : ruta.slice(1))),
        { headers:{ 'content-type':ruta === '/portal' || ruta === '/manual' ? 'text/html' : 'text/javascript' } });
    } } as unknown as Fetcher;
    for (const ruta of ['/', '/portal', '/portal.html', '/portal.js', '/catalogo-ficha.js', '/apartar.js', '/apartados.js', '/pagos.js', '/comprobante.js', '/portal.css', '/code128.js', '/vendor/qrcode-generator.js', '/el-dolaron-logo.png',
      '/manual', '/manual.js', '/vender.js']) {
      const r = await worker.fetch!(new Request('https://portal.prueba' + ruta) as never, p.env, {} as never);
      assert.equal(r.status, 200, ruta);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      const cuerpo = await r.text();
      assert.ok(cuerpo.length);
    }
    for (const ruta of ['/caja', '/caja.html', '/admin', '/cuentas', '/socios', '/captura',
      '/cajero.js', '/venta.js', '/vender', '/vender.html', '/manual.html', '/manual/', '/api/vender', '/api/ventas', '/api/socios/codigo', '/api/socios/vincular',
      '/api/foto/123', '/api/portal/llegada', '/foo/portal.html'])
      assert.equal((await p.llamar(ruta, '')).status, 404, ruta);
    assert.equal(leidos.length, 16);
    // El manual (#623) sale solo por GET/HEAD.
    assert.equal((await p.llamar('/manual', '', {}, 'POST')).status, 404);
    assert.equal((await p.llamar('/portal.js', '', {}, 'POST')).status, 404);
    assert.equal((await p.pedir('/api/portal/config')).status, 404);
    const config = await p.llamar('/api/portal/config', '');
    assert.equal(config.status, 200);
    assert.ok(config.body.firebase);
    assert.equal(config.body.bases, 'Bases sintéticas de prueba.');
    p.env.PORTAL_AVISO_TEXTO = 'Responsable, RFC {{RFC}}.';
    assert.equal((await p.llamar('/api/portal/config', '')).body.firebase, null);
    p.env.PORTAL_AVISO_TEXTO = 'Aviso sintético de prueba.';
    delete p.env.BASES_APROBADAS_VERSION;
    assert.equal((await p.llamar('/api/portal/config', '')).body.firebase, null);
    assert.equal((await p.registrar('nuevo', '+524448887777')).status, 503);
  } finally { p.cerrar(); }
});

test('barcode privado: monto limitado, caducidad, un solo uso e idempotencia de la compra', async () => {
  const p = portalDePrueba();
  try {
    const a = await p.registrar('a', '+524440001111'), b = await p.registrar('b', '+524440002222');
    const auth = token('a', '+524440001111');
    assert.equal((await p.llamar('/api/portal/codigo', '', { maximo:100 }, 'POST')).status, 401);
    for (const maximo of [-1, 0.5, '100', null, 9007199254740992])
      assert.equal((await p.llamar('/api/portal/codigo', auth, { maximo }, 'POST')).status, 400);
    assert.equal((await p.llamar('/api/portal/codigo', auth, { maximo:30001 }, 'POST')).status, 409);
    const emitido = await p.llamar('/api/portal/codigo', auth, { maximo:10000 }, 'POST');
    assert.equal(emitido.status, 201);
    assert.match(emitido.body.codigo, /^DC-[A-Za-z0-9_-]{16}$/);
    assert.equal((await p.llamar('/api/portal/codigo', auth, { maximo:10000 }, 'POST')).status, 429);
    const fila = p.db.prepare('select token_hash from codigos_cliente').get()!;
    assert.equal(String(fila.token_hash).length, 64);
    assert.notEqual(fila.token_hash, emitido.body.codigo);
    const socio = await p.pedir('/api/socios/codigo', { codigo:emitido.body.codigo });
    assert.equal(socio.status, 200);
    assert.equal(socio.cuerpo.id, a.body.id);
    assert.equal(socio.cuerpo.maximo, 10000);
    const v = { id:crypto.randomUUID(), cliente_id:a.body.id, dolarones:10000,
      codigo_socio:emitido.body.codigo, lineas:[{ producto_id:PRODUCTO, cantidad:4 }], forma_pago:'tarjeta' };
    assert.equal((await p.pedir('/api/ventas', { ...v, dolarones:10001 })).status, 403);
    assert.equal((await p.pedir('/api/ventas', { ...v, cliente_id:b.body.id })).status, 403);
    assert.equal((await p.pedir('/api/ventas', v)).status, 201);
    assert.equal((await p.pedir('/api/ventas', v)).cuerpo.duplicada, true);
    assert.equal((await p.pedir('/api/ventas', { ...v, id:crypto.randomUUID() })).status, 403);
    assert.equal((await p.pedir('/api/socios/codigo', { codigo:emitido.body.codigo })).status, 403);
    p.db.prepare("update codigos_cliente set creado_en='2020-01-01'").run();
    const acumular = await p.llamar('/api/portal/codigo', auth, { maximo:0 }, 'POST');
    assert.equal(acumular.status, 201);
    assert.equal((await p.pedir('/api/ventas', { ...v, id:crypto.randomUUID(), codigo_socio:acumular.body.codigo })).status, 403);
    p.db.prepare("update codigos_cliente set expira_en='2020-01-01'").run();
    assert.equal((await p.pedir('/api/socios/codigo', { codigo:acumular.body.codigo })).status, 403);
    // Bases v3: sin máximo, el código autoriza todo el saldo (en caja se pregunta si se usa).
    p.db.prepare("update codigos_cliente set creado_en='2020-01-01'").run();
    const todo = await p.llamar('/api/portal/codigo', auth, {}, 'POST');
    assert.equal(todo.status, 201);
    assert.equal(todo.body.maximo, (await p.llamar('/api/portal/saldo', auth)).body.disponible_total);
    // Bases v3: el premio de apertura vence 24 h después de otorgarse.
    const premio = p.db.prepare("select creado_en, vence_en from dolarones_lotes where cliente_id = ? and origen = 'regalo'").get(a.body.id)!;
    assert.equal(Date.parse(String(premio.vence_en)) - Date.parse(String(premio.creado_en)), 86_400_000);
  } finally { p.cerrar(); }
});

test('logout revoca el código y sólo el dueño vincula un registro presencial, sin perder historial', async () => {
  const p = portalDePrueba();
  try {
    const a = await p.registrar('a', '+524440001111');
    const auth = token('a', '+524440001111');
    const k = await p.llamar('/api/portal/codigo', auth, { maximo:0 }, 'POST');
    assert.equal((await p.llamar('/api/portal/codigo', auth, undefined, 'DELETE')).status, 200);
    assert.equal((await p.pedir('/api/socios/codigo', { codigo:k.body.codigo })).status, 403);
    const previo = await p.pedir('/api/socios', { id:crypto.randomUUID(), nombre:'Socio previo', telefono:'4445556666', acepta_bases:true, declara_mayor_edad:true });
    assert.equal(previo.status, 201);
    assert.equal((await p.registrar('nuevo', '+524445556666')).status, 409);
    const vk = await p.llamar('/api/portal/vinculo', token('nuevo', '+524445556666'), {}, 'POST');
    assert.equal(vk.status, 201);
    assert.equal((await p.llamar('/api/portal/yo', token('nuevo', '+524445556666'))).status, 404);
    const body = { numero:previo.cuerpo.numero, codigo:vk.body.codigo, confirma:true };
    p.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
      values ('cajero@prueba.mx', 'Caja', 'cajero', 1, '', '')`).run();
    p.env.DEV_USUARIO = 'cajero@prueba.mx';
    assert.equal((await p.pedir('/api/socios/vincular', body)).status, 403);
    p.env.DEV_USUARIO = 'dueno@prueba.mx';
    assert.equal((await p.pedir('/api/socios/vincular', { ...body, numero:a.body.numero })).status, 409);
    assert.equal((await p.pedir('/api/socios/vincular', body)).status, 200);
    assert.equal((await p.llamar('/api/portal/yo', token('nuevo', '+524445556666'))).body.id, previo.cuerpo.id);
    assert.equal((await p.pedir('/api/socios/vincular', body)).status, 403);
    assert.equal(p.db.prepare('select count(*) as n from clientes').get()!.n, 2);
  } finally { p.cerrar(); }
});

test('un canje entre lectura y reemplazo aborta regalo, cupo y presupuesto juntos', async () => {
  const p = portalDePrueba();
  try {
    const a = await p.registrar('primera', '+524440009999');
    const lote = a.body.premio.lote_id;
    const batch = p.env.DB.batch.bind(p.env.DB);
    p.env.DB.batch = async (sentencias) => {
      p.db.prepare('update dolarones_lotes set restante=restante-100 where id=?').run(lote);
      return batch(sentencias);
    };
    const r = await p.pedir('/api/portal/llegada', { cliente_id:a.body.id });
    assert.equal(r.status, 409);
    assert.equal(p.db.prepare('select restante from dolarones_lotes where id=?').get(lote)!.restante, 29900);
    assert.equal(p.db.prepare("select count(*) as n from premios_apertura where canal='tienda' and cliente_id is not null").get()!.n, 0);
    assert.equal(p.db.prepare("select count(*) as n from dolarones_movimientos where tipo='reemplazo'").get()!.n, 0);
    assert.equal(p.db.prepare("select count(*) as n from premios_apertura where canal='online' and cliente_id=?").get(a.body.id)!.n, 1);
  } finally { p.cerrar(); }
});

test('vale de papel a la cuenta (Issue #258): doble, una vez, tope semanal y reglas de socio', async () => {
  const p = portalDePrueba();
  p.env.VALES_ABIERTOS = 'si';
  try {
    const venta = (extra: Record<string, unknown> = {}) => p.pedir('/api/ventas', { id: crypto.randomUUID(),
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra });
    const emitir = async () => { const r = await venta(); assert.equal(r.status, 201); return { id: r.cuerpo.id as string, vale: r.cuerpo.vale_emitido }; };
    const ta = token('uid-a', '+524441112222'), tb = token('uid-b', '+524443334444');
    const a = (await p.registrar('uid-a', '+524441112222')).body;
    await p.registrar('uid-b', '+524443334444');
    const pasar = (t: string, codigo: string) => p.llamar('/api/portal/vale', t, { codigo }, 'POST');

    // $250 sin socio: vale de 10 D. En la cuenta: 20 D, con las reglas de compra de socio.
    const uno = await emitir();
    assert.equal(uno.vale.importe, 1000);
    const r = await pasar(ta, uno.vale.codigo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.importe, 2000);
    const k = p.db.prepare('select restante, reclamado_por from vales_dolarones where id = ?').get(uno.vale.id) as any;
    assert.deepEqual([k.restante, k.reclamado_por], [0, a.id]);
    assert.equal((p.db.prepare('select cliente_id from ventas where id = ?').get(uno.id) as any).cliente_id, a.id);
    const lote = p.db.prepare(`select origen, importe, vence_en from dolarones_lotes where venta_id = ?`).get(uno.id) as any;
    assert.equal(lote.origen, 'compra');
    assert.ok(lote.vence_en > new Date(Date.now() + 360 * 86_400_000).toISOString());
    assert.equal((await p.llamar('/api/portal/saldo', ta)).body.por_liberar, 2000);
    assert.deepEqual((await p.llamar('/api/portal/recibos', ta)).body.recibos.map((x: any) => x.id), [uno.id]);
    // Repetir (otra pestaña, recargar) no abona dos veces; otra cuenta no se lo lleva; el papel ya no sirve.
    assert.equal((await pasar(ta, uno.vale.codigo)).body.ya_estaba, true);
    assert.equal((await pasar(tb, uno.vale.codigo)).status, 409);
    assert.equal((await p.pedir('/api/vales/buscar', { codigo: uno.vale.codigo })).status, 403);
    assert.equal((p.db.prepare('select count(*) n from dolarones_lotes where venta_id = ?').get(uno.id) as any).n, 1);

    // Vale usado en parte: no se pasa.
    const usado = await emitir();
    p.db.prepare(`update vales_dolarones set disponible_desde = '2020-01-01T00:00:00Z' where id = ?`).run(usado.vale.id);
    assert.equal((await venta({ codigo_vale: usado.vale.codigo, dolarones: 500, efectivo: 24500 })).status, 201);
    assert.equal((await pasar(ta, usado.vale.codigo)).status, 409);
    // Vencido: no se pasa.
    const viejo = await emitir();
    p.db.prepare(`update vales_dolarones set vence_en = '2020-01-01T00:00:00Z' where id = ?`).run(viejo.vale.id);
    assert.equal((await pasar(ta, viejo.vale.codigo)).status, 409);

    // Tope: 2 por semana por cuenta.
    const dos = await emitir();
    assert.equal((await pasar(ta, dos.vale.codigo)).status, 201);
    const tres = await emitir();
    const tope = await pasar(ta, tres.vale.codigo);
    assert.equal(tope.status, 429);
    assert.equal((p.db.prepare('select restante from vales_dolarones where id = ?').get(tres.vale.id) as any).restante, 1000);
    assert.equal((await pasar(tb, tres.vale.codigo)).status, 201);   // otra cuenta sí puede

    // Cancelar la compra ya pasada: se retira lo abonado de la cuenta, sin tropezar con el vale.
    const cancelada = await p.pedir(`/api/ventas/${dos.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(cancelada.status, 200, JSON.stringify(cancelada.cuerpo));
    assert.equal((p.db.prepare('select restante from dolarones_lotes where venta_id = ?').get(dos.id) as any).restante, 0);
    // Y su vale no revive.
    assert.equal((p.db.prepare('select restante from vales_dolarones where id = ?').get(dos.vale.id) as any).restante, 0);
  } finally { p.cerrar(); }
});

test('host público: tope por IP en la API, fotos del catálogo fuera, y HSTS en toda respuesta', async () => {
  const p = portalDePrueba();
  try {
    const llaves: string[] = [];
    p.env.LIMITE_PORTAL = { limit: async ({ key }: { key: string }) => { llaves.push(key); return { success: false }; } } as never;
    const pedir = (ruta: string) => worker.fetch!(new Request(`https://portal.prueba${ruta}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }) as never, p.env, { waitUntil() {} } as never);
    const limitada = await pedir('/api/portal/config');
    assert.equal(limitada.status, 429);
    assert.equal(limitada.headers.get('retry-after'), '60');
    assert.deepEqual(llaves, ['203.0.113.9']);
    assert.notEqual((await pedir('/api/catalogo/foto/ED-000001')).status, 429);
    assert.equal(limitada.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    delete (p.env as Record<string, unknown>).LIMITE_PORTAL;
    const libre = await pedir('/api/portal/config');
    assert.equal(libre.status, 200);
    assert.equal(libre.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  } finally { p.cerrar(); }
});

test('sin PREMIOS_APERTURA no se otorgan premios nuevos ni primera llegada (Issue #611)', async () => {
  const p = portalDePrueba();
  delete p.env.PREMIOS_APERTURA;
  try {
    const a = await p.registrar('uid-sin-promo', '+524440000611');
    assert.equal(a.status, 200);
    assert.equal(a.body.premio, null);
    assert.equal(p.db.prepare("select count(*) as n from dolarones_lotes where origen = 'regalo'").get()!.n, 0);
    assert.equal(p.db.prepare("select count(*) as n from dolarones_movimientos where tipo = 'regalo'").get()!.n, 0);
    assert.equal(p.db.prepare('select count(cliente_id) as n from premios_apertura').get()!.n, 0);
    const r = await p.pedir('/api/portal/llegada', { cliente_id: a.body.id });
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.premio, null);
    assert.equal(p.db.prepare('select count(*) as n from primera_llegada').get()!.n, 0);
    assert.equal(p.db.prepare("select count(*) as n from dolarones_lotes where origen = 'regalo'").get()!.n, 0);
  } finally { p.cerrar(); }
});

test('apagar la promoción respeta el premio ya otorgado (Issue #611)', async () => {
  const p = portalDePrueba();
  try {
    const a = await p.registrar('uid-previo', '+524440000612');
    assert.equal(a.body.premio.importe, 300_00);
    delete p.env.PREMIOS_APERTURA;
    const r = await p.pedir('/api/portal/llegada', { cliente_id: a.body.id });
    assert.equal(r.cuerpo.premio.importe, 300_00);
    assert.equal(r.cuerpo.premio.lote_id, a.body.premio.lote_id);
    assert.equal(p.db.prepare('select count(*) as n from primera_llegada').get()!.n, 0);
    assert.equal((await p.registrar('uid-previo', '+524440000612')).body.premio.importe, 300_00);
  } finally { p.cerrar(); }
});

test('POST /api/portal/apartar (#668): pide sesión, socio y bases vigentes; el teléfono sale de la cuenta, la pieza del servidor', async () => {
  const p = portalDePrueba();
  try {
    const id = 'c0000001-1111-4111-8111-111111111111';
    p.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
      values (?, 'ED-000777', 'Chamarra Levis', 25000, 2, 'listo', 'fotos/x.jpg', 'S40', '', '')`).run(id);
    const cuerpo = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), codigo: 'ED-000777', entrega: 'tienda', ...extra });
    const auth = token('uid-apartar', '+524441112222');
    // Sin sesión válida, sin registro y con un método que no es POST.
    assert.equal((await p.llamar('/api/portal/apartar', token('uid-apartar', '+524441112222', { aud: 'otro' }), cuerpo(), 'POST')).status, 401);
    assert.equal((await p.llamar('/api/portal/apartar', auth, cuerpo(), 'POST')).status, 404);   // aún no es socio
    assert.equal((await p.registrar('uid-apartar', '+524441112222')).status, 200);
    assert.equal((await p.llamar('/api/portal/apartar', auth)).status, 405);
    assert.equal((await p.pedir('/api/portal/apartar', cuerpo())).status, 404);   // host del personal: ni existe
    assert.equal(p.db.prepare('select stock from productos where id = ?').get(id)!.stock, 2);

    p.env.PORTAL_DATOS_PAGO = 'Banco de prueba';
    const mala = await p.llamar('/api/portal/apartar', auth, cuerpo({ codigo: 'otra cosa' }), 'POST');
    assert.equal(mala.status, 400);
    const r = await p.llamar('/api/portal/apartar', auth, cuerpo({ cliente: 'Intruso', telefono: '4440000000', precio: 1, anticipo: 99999 }), 'POST');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.concepto, 'P-1');
    assert.equal(r.body.datos_pago, 'Banco de prueba');
    assert.equal(r.body.pedido.subtotal, 25000);
    const fila = p.db.prepare('select vendedora, cliente, telefono, anticipo, saldo from pedidos where folio = 1').get()!;
    assert.deepEqual({ ...fila }, { vendedora: 'portal', cliente: 'Cliente', telefono: '4441112222', anticipo: 0, saldo: 0 });
    assert.equal(p.db.prepare('select stock from productos where id = ?').get(id)!.stock, 1);

    // Bases vigentes: quien no las aceptó no aparta (la pantalla le pide aceptarlas primero).
    p.db.prepare("update clientes set bases_version = 'vieja' where auth_uid = 'uid-apartar'").run();
    const sin = await p.llamar('/api/portal/apartar', auth, cuerpo(), 'POST');
    assert.equal(sin.status, 409);
    assert.match(sin.body.error, /bases vigentes/);
    assert.equal(p.db.prepare('select stock from productos where id = ?').get(id)!.stock, 1);
  } finally { p.cerrar(); }
});

/* ---------- Mis apartados (#669) ---------- */

let consecutivoApartados = 800;
function piezaVendible(p: ReturnType<typeof portalDePrueba>, precio = 25000, stock = 1) {
  const n = ++consecutivoApartados;
  const id = `c${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`, codigo = `ED-000${n}`;
  p.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Chamarra Levis', ?, ?, 'listo', ?, 'S40', '', '')`).run(id, codigo, precio, stock, `fotos/${id}.jpg`);
  (p.env.FOTOS as any).objetos.set(`fotos/${id}.jpg`, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
  return { id, codigo };
}
const stockPieza = (p: ReturnType<typeof portalDePrueba>, id: string) => Number(p.db.prepare('select stock from productos where id = ?').get(id)!.stock);

test('GET /api/portal/apartados (#669): solo los de su teléfono (también los de la tienda), sin datos internos y con cancelable correcto', async () => {
  const p = portalDePrueba();
  try {
    const A = token('uid-a', '+524441112222'), B = token('uid-b', '+524443334444');
    assert.equal((await p.llamar('/api/portal/apartados', token('uid-a', '+524441112222', { aud: 'otro' }))).status, 401);
    assert.equal((await p.llamar('/api/portal/apartados', A)).status, 404);   // aún no es socio
    await p.registrar('uid-a', '+524441112222');
    await p.registrar('uid-b', '+524443334444');
    assert.equal((await p.llamar('/api/portal/apartados', A, {}, 'POST')).status, 405);
    assert.deepEqual((await p.llamar('/api/portal/apartados', A)).body, { datos_pago: null, apartados: [] });

    const sinPago = piezaVendible(p), envio = piezaVendible(p, 25000), revisando = piezaVendible(p), deB = piezaVendible(p), deTienda = piezaVendible(p, 25000, 3);
    const apartar = (auth: string, pieza: { codigo: string }, entrega = 'tienda') =>
      p.llamar('/api/portal/apartar', auth, { id: crypto.randomUUID(), codigo: pieza.codigo, entrega }, 'POST');
    assert.equal((await apartar(A, sinPago)).status, 201);
    assert.equal((await apartar(A, envio, 'envio')).status, 201);
    assert.equal((await apartar(A, revisando)).status, 201);
    assert.equal((await apartar(B, deB)).status, 201);
    // La tienda levantó un apartado por WhatsApp a ese mismo teléfono (con $100 de anticipo): también es suyo.
    const tienda = await p.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: deTienda.id, cantidad: 1 }], cliente: 'Lucía', telefono: '4441112222',
      entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
    assert.equal(tienda.status, 201, JSON.stringify(tienda.cuerpo));
    // Un pago por revisar en el tercero del portal (#609/B2).
    p.db.prepare("insert into pagos_reportados (pedido_id, solicitud_id, clave_rastreo, reportado_por, reportado_en) values ((select id from pedidos where folio = 3), ?, 'ABCDEF12', 'portal:x', ?)")
      .run(crypto.randomUUID(), new Date().toISOString());

    const lista = (await p.llamar('/api/portal/apartados', A)).body.apartados as Record<string, any>[];
    assert.deepEqual(lista.map((a) => a.folio), [5, 3, 2, 1]);   // el 4 es de B; folio descendente
    const por = (folio: number) => lista.find((a) => a.folio === folio)!;
    for (const a of lista) {
      assert.deepEqual(Object.keys(a).sort(), ['cancelable', 'creado_en', 'entrega', 'envio', 'estado', 'faltante', 'folio', 'guia', 'lineas', 'liquidado_en', 'pago_reportado', 'saldo', 'subtotal', 'vence_en', 'viernes_envio']);
      assert.deepEqual(Object.keys(a.lineas[0]).sort(), ['cantidad', 'codigo', 'nombre', 'precio']);
    }
    assert.deepEqual([por(1).cancelable, por(1).faltante, por(1).viernes_envio, por(1).pago_reportado], [true, 25000, null, null]);
    assert.equal(por(1).lineas[0].codigo, sinPago.codigo);
    assert.deepEqual([por(2).entrega, por(2).envio, por(2).faltante, por(2).cancelable], ['envio', 9900, 34900, true]);
    assert.equal(por(2).viernes_envio, null);   // el viernes se fija al liquidar
    assert.deepEqual([por(3).cancelable, por(3).pago_reportado.estado], [false, 'pendiente']);
    assert.deepEqual([por(5).cancelable, por(5).saldo, por(5).faltante], [false, 10000, 15000]);   // lo levantó la tienda: solo ella lo cancela
    assert.equal(Date.parse(por(1).vence_en) - Date.parse(por(1).creado_en), 24 * 3_600_000);
    // B solo ve el suyo.
    assert.deepEqual(((await p.llamar('/api/portal/apartados', B)).body.apartados as any[]).map((a) => a.folio), [4]);

    // La tienda registra el abono del paquete de envío: sigue abierto, ya no es cancelable desde el portal.
    const abono = await p.pedir('/api/pedidos/2/abonos', { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
    assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
    const despues = ((await p.llamar('/api/portal/apartados', A)).body.apartados as any[]).find((a) => a.folio === 2);
    assert.deepEqual([despues.cancelable, despues.saldo, despues.faltante], [false, 10000, 24900]);
    const liquidar = await p.pedir('/api/pedidos/2/abonos', { id: crypto.randomUUID(), importe: 24900, forma_pago: 'efectivo', caja: 'Caja 1' });
    assert.equal(liquidar.status, 200);
    const vendido = ((await p.llamar('/api/portal/apartados', A)).body.apartados as any[]).find((a) => a.folio === 2);
    assert.deepEqual([vendido.estado, vendido.faltante, vendido.guia, vendido.viernes_envio === viernesDeEnvio(vendido.liquidado_en)], ['vendido', 0, '', true]);
    assert.equal((await p.pedir('/api/pedidos/2/guia', { guia: 'DHL 434' }, 'PUT')).status, 200);
    assert.equal(((await p.llamar('/api/portal/apartados', A)).body.apartados as any[]).find((a) => a.folio === 2).guia, 'DHL 434');
  } finally { p.cerrar(); }
});

test('POST /api/portal/apartados/:folio/cancelar (#669): devuelve la existencia una vez; ajeno 404; con pago, de la tienda o por revisar, 409', async () => {
  const p = portalDePrueba();
  try {
    const A = token('uid-a', '+524441112222'), B = token('uid-b', '+524443334444');
    await p.registrar('uid-a', '+524441112222');
    await p.registrar('uid-b', '+524443334444');
    const a = piezaVendible(p), b = piezaVendible(p), c = piezaVendible(p), d = piezaVendible(p, 25000, 3);
    const apartar = (auth: string, pieza: { codigo: string }) => p.llamar('/api/portal/apartar', auth, { id: crypto.randomUUID(), codigo: pieza.codigo, entrega: 'tienda' }, 'POST');
    assert.equal((await apartar(A, a)).status, 201);   // folio 1
    assert.equal((await apartar(A, b)).status, 201);   // folio 2
    assert.equal((await apartar(A, c)).status, 201);   // folio 3
    assert.equal(stockPieza(p, a.id), 0);
    const cancelar = (auth: string, folio: number, metodo = 'POST') => p.llamar(`/api/portal/apartados/${folio}/cancelar`, auth, metodo === 'POST' ? {} : undefined, metodo);

    assert.equal((await cancelar(A, 1, 'GET')).status, 405);
    assert.equal((await cancelar(B, 1)).status, 404);   // folio ajeno: ni se entera
    assert.equal((await cancelar(A, 99)).status, 404);
    assert.equal(stockPieza(p, a.id), 0);
    // Cancelar: la pieza vuelve una sola vez, aunque lleguen dos cancelaciones.
    const [x, y] = await Promise.all([cancelar(A, 1), cancelar(A, 1)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(stockPieza(p, a.id), 1);
    assert.equal(p.db.prepare('select estado from pedidos where folio = 1').get()!.estado, 'cancelado');
    assert.equal((await cancelar(A, 1)).status, 409);
    assert.equal(stockPieza(p, a.id), 1);
    // Y deja un cupo: el tope cuenta solo los apartados sin pago.
    const lista = (await p.llamar('/api/portal/apartados', A)).body.apartados as any[];
    assert.deepEqual([lista.find((e) => e.folio === 1).estado, lista.find((e) => e.folio === 1).cancelable], ['cancelado', false]);

    // Con un pago por revisar no se cancela (el cliente ya pagó): lo decide la tienda.
    p.db.prepare("insert into pagos_reportados (pedido_id, solicitud_id, clave_rastreo, reportado_por, reportado_en) values ((select id from pedidos where folio = 2), ?, 'ABCDEF12', 'portal:x', ?)")
      .run(crypto.randomUUID(), new Date().toISOString());
    assert.equal((await cancelar(A, 2)).status, 409);
    assert.equal(stockPieza(p, b.id), 0);
    // Con dinero registrado tampoco.
    assert.equal((await p.pedir('/api/pedidos/3/abonos', { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Caja 1' })).status, 200);
    assert.equal((await cancelar(A, 3)).status, 409);
    assert.equal(stockPieza(p, c.id), 0);
    // Un apartado que levantó la tienda con su número no es del portal: 404 (lo cancela la tienda).
    const tienda = await p.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: d.id, cantidad: 1 }], cliente: 'Lucía', telefono: '4441112222',
      entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
    assert.equal((await cancelar(A, tienda.cuerpo.pedido.folio)).status, 404);
    assert.equal(stockPieza(p, d.id), 2);
  } finally { p.cerrar(); }
});

test('la foto del catálogo sigue saliendo mientras la pieza está apartada (para «Mis apartados») y no la de una agotada sin pedido', async () => {
  const p = portalDePrueba();
  try {
    await p.registrar('uid-a', '+524441112222');
    const a = piezaVendible(p), agotada = piezaVendible(p, 25000, 0);
    const foto = (codigo: string) => worker.fetch!(new Request(`https://portal.prueba/api/catalogo/foto/${codigo}`) as never, p.env, { waitUntil() {} } as never);
    assert.equal((await foto(a.codigo)).status, 200);
    assert.equal((await p.llamar('/api/portal/apartar', token('uid-a', '+524441112222'), { id: crypto.randomUUID(), codigo: a.codigo, entrega: 'tienda' }, 'POST')).status, 201);
    assert.equal(stockPieza(p, a.id), 0);
    assert.equal((await foto(a.codigo)).status, 200);
    assert.equal((await foto(agotada.codigo)).status, 404);
    // Vencida o cancelada vuelve a la venta (stock 1) y sigue sirviéndose por ser vendible.
    assert.equal(await vencerPedidos(p.env, new Date(Date.now() + 25 * 3_600_000)), 1);
    assert.equal((await foto(a.codigo)).status, 200);
    // Ya sin pedido abierto, agotarse la deja sin foto como a cualquier otra.
    p.db.prepare('update productos set stock = 0 where id = ?').run(a.id);
    assert.equal((await foto(a.codigo)).status, 404);
  } finally { p.cerrar(); }
});

/* ---------- Ya pagué: el socio reporta su transferencia (#670) ---------- */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const claveUnica = (() => { let n = 0; return () => `PORTAL${String(++n).padStart(8, '0')}`; })();

async function socioConApartado(p: ReturnType<typeof portalDePrueba>, uid = 'uid-a', telefono = '+524441112222') {
  await p.registrar(uid, telefono);
  const auth = token(uid, telefono);
  const pieza = piezaVendible(p);
  const r = await p.llamar('/api/portal/apartar', auth, { id: crypto.randomUUID(), codigo: pieza.codigo, entrega: 'tienda' }, 'POST');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { auth, pieza, folio: r.body.pedido.folio as number };
}
const subirComprobante = async (p: ReturnType<typeof portalDePrueba>, auth: string, folio: number, cuerpo: BodyInit = JPEG, tipo = 'image/jpeg') => {
  const r = await worker.fetch!(new Request(`https://portal.prueba/api/portal/apartados/${folio}/comprobante`,
    { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': tipo }, body: cuerpo }) as never, p.env, { waitUntil() {} } as never);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const reportarPortal = (p: ReturnType<typeof portalDePrueba>, auth: string, folio: number, cuerpo: Record<string, unknown> = {}) =>
  p.llamar(`/api/portal/apartados/${folio}/pago`, auth, { id: crypto.randomUUID(), clave_rastreo: claveUnica(), ...cuerpo }, 'POST');

test('el socio reporta su pago (#670): queda pendiente a nombre del portal, el aviso no lleva clave ni teléfono y el apartado no vence', async () => {
  const p = portalDePrueba();
  try {
    const enviados: { subject: string; text: string }[] = [];
    (p.env as any).CORREO = { send: async (m: any) => { enviados.push(m); } };
    const { auth, folio } = await socioConApartado(p);
    const clave = claveUnica();
    const id = crypto.randomUUID();
    const r = await p.llamar(`/api/portal/apartados/${folio}/pago`, auth, { id, clave_rastreo: ` ${clave.toLowerCase()} `, monto: 10000, banco_emisor: '40012' }, 'POST');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.reporte.estado, r.body.reporte.motivo], ['pendiente', '']);
    const fila = p.db.prepare('select * from pagos_reportados').get()!;
    assert.deepEqual([fila.clave_rastreo, fila.monto, fila.banco_emisor, String(fila.reportado_por).startsWith('portal:')], [clave, 10000, '40012', true]);
    assert.equal(fila.reportado_por, `portal:${p.db.prepare("select id from clientes where auth_uid = 'uid-a'").get()!.id}`);
    // No es dinero: ni saldo ni movimientos; el apartado sigue abierto.
    assert.deepEqual({ ...p.db.prepare('select saldo, estado from pedidos where folio = ?').get(folio)! }, { saldo: 0, estado: 'apartado' });
    assert.equal(p.db.prepare('select count(*) as n from pedido_movimientos').get()!.n, 0);
    await p.esperar();
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].text, new RegExp(`Cliente mandó el pago de P-${folio} desde el portal\\.`));
    for (const secreto of [clave, '4441112222', 'uid-a']) assert.ok(!enviados[0].text.includes(secreto) && !enviados[0].subject.includes(secreto), secreto);
    // Reintento con el mismo id: el mismo reporte, sin duplicar ni volver a avisar.
    const otra = await p.llamar(`/api/portal/apartados/${folio}/pago`, auth, { id, clave_rastreo: clave }, 'POST');
    assert.deepEqual([otra.status, otra.body.reporte.id], [200, r.body.reporte.id]);
    assert.equal(p.db.prepare('select count(*) as n from pagos_reportados').get()!.n, 1);
    // Un segundo pendiente en el mismo pedido: 409. Y una clave ya usada en otro: 409.
    assert.equal((await reportarPortal(p, auth, folio)).status, 409);
    // El cron no lo vence mientras la tienda lo revisa; el socio ve «Pago en revisión» y ya no lo puede cancelar.
    assert.equal(await vencerPedidos(p.env, new Date(Date.now() + 48 * 3_600_000)), 0);
    const lista = (await p.llamar('/api/portal/apartados', auth)).body.apartados as any[];
    assert.deepEqual([lista[0].pago_reportado.estado, lista[0].cancelable], ['pendiente', false]);
    assert.equal((await p.llamar(`/api/portal/apartados/${folio}/cancelar`, auth, {}, 'POST')).status, 409);
  } finally { p.cerrar(); }
});

test('el socio solo reporta lo suyo: folio ajeno 404, clave repetida 409, foto de otro pedido o de otro socio rechazada, método y validaciones', async () => {
  const p = portalDePrueba();
  try {
    const a = await socioConApartado(p, 'uid-a', '+524441112222');
    const b = await socioConApartado(p, 'uid-b', '+524443334444');
    assert.equal((await reportarPortal(p, b.auth, a.folio)).status, 404);
    assert.equal((await subirComprobante(p, b.auth, a.folio)).status, 404);
    assert.equal((await reportarPortal(p, a.auth, 999)).status, 404);
    assert.equal((await p.llamar(`/api/portal/apartados/${a.folio}/pago`, a.auth)).status, 405);
    assert.equal((await p.llamar(`/api/portal/apartados/${a.folio}/comprobante`, a.auth)).status, 405);
    assert.equal((await p.llamar(`/api/portal/apartados/${a.folio}/pago`, token('uid-a', '+524441112222', { aud: 'otro' }), {}, 'POST')).status, 401);
    assert.equal(p.db.prepare('select count(*) as n from pagos_reportados').get()!.n, 0);

    const mala = (cuerpo: Record<string, unknown>) => p.llamar(`/api/portal/apartados/${a.folio}/pago`, a.auth, { id: crypto.randomUUID(), ...cuerpo }, 'POST');
    assert.equal((await mala({})).body.campo, 'clave');                                 // ni foto ni clave
    assert.equal((await mala({ clave_rastreo: 'abc' })).body.campo, 'clave');           // 6 a 30
    assert.equal((await mala({ clave_rastreo: claveUnica(), banco_emisor: '99999' })).body.campo, 'banco');
    assert.equal((await mala({ clave_rastreo: claveUnica(), monto: -5 })).body.campo, 'monto');
    assert.equal((await p.llamar(`/api/portal/apartados/${a.folio}/pago`, a.auth, { clave_rastreo: claveUnica() }, 'POST')).status, 400);   // sin id

    // La foto: la sube y se guarda bajo su pedido; no sirve en el de otro ni subida por otro socio.
    const subida = await subirComprobante(p, a.auth, a.folio);
    assert.equal(subida.status, 200, JSON.stringify(subida.body));
    assert.match(subida.body.key, /^comprobantes\/[0-9a-f-]{36}\.jpg$/);
    assert.equal(p.db.prepare('select subido_por from comprobantes_subidos where comprobante_key = ?').get(subida.body.key)!.subido_por.startsWith('portal:'), true);
    assert.equal((await subirComprobante(p, a.auth, a.folio, 'no es imagen', 'text/plain')).status, 415);
    const ajena = await reportarPortal(p, b.auth, b.folio, { comprobante_key: subida.body.key, clave_rastreo: undefined });
    assert.deepEqual([ajena.status, ajena.body.campo], [400, 'foto']);
    const conFoto = await reportarPortal(p, a.auth, a.folio, { comprobante_key: subida.body.key, clave_rastreo: undefined, fecha_comprobante: '2026-11-02' });
    assert.equal(conFoto.status, 201, JSON.stringify(conFoto.body));

    // Una clave sirve para un solo pago: B no puede mandar la que ya espera en el pedido de A.
    const clave = p.db.prepare('select clave_rastreo from pagos_reportados').get()!.clave_rastreo;
    assert.equal(clave, null);
    const usada = claveUnica();
    p.db.prepare("update pagos_reportados set estado = 'rechazado', motivo = 'x'").run();
    assert.equal((await reportarPortal(p, a.auth, a.folio, { clave_rastreo: usada })).status, 201);
    const repetida = await reportarPortal(p, b.auth, b.folio, { clave_rastreo: usada });
    assert.deepEqual([repetida.status, repetida.body.campo], [409, 'clave']);
    assert.equal(p.db.prepare('select count(*) as n from pagos_reportados').get()!.n, 2);
  } finally { p.cerrar(); }
});

test('la tienda acepta el reporte del socio con el abono, o lo rechaza con motivo y el socio manda otro', async () => {
  const p = portalDePrueba();
  try {
    const { auth, folio } = await socioConApartado(p);
    const primero = await reportarPortal(p, auth, folio);
    assert.equal(primero.status, 201);
    // La tienda lo rechaza: el socio lo ve con el motivo, el plazo sigue y puede mandar otro.
    assert.equal((await p.pedir(`/api/pedidos/${folio}/rechazar-pago`, { motivo: 'No llegó el dinero' })).status, 200);
    const visto = ((await p.llamar('/api/portal/apartados', auth)).body.apartados as any[])[0];
    assert.deepEqual([visto.pago_reportado.estado, visto.pago_reportado.motivo, visto.cancelable], ['rechazado', 'No llegó el dinero', true]);
    const segundo = await reportarPortal(p, auth, folio);
    assert.equal(segundo.status, 201, JSON.stringify(segundo.body));
    // El abono que registra la tienda acepta el reporte en el mismo batch y el apartado pasa a 7 días.
    const abono = await p.pedir(`/api/pedidos/${folio}/abonos`, { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
    assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
    const aceptado = p.db.prepare("select estado from pagos_reportados order by id desc limit 1").get()!;
    assert.equal(aceptado.estado, 'aceptado');
    const final = ((await p.llamar('/api/portal/apartados', auth)).body.apartados as any[])[0];
    assert.deepEqual([final.saldo, final.cancelable, final.pago_reportado.estado], [10000, false, 'aceptado']);
    // Con dinero registrado ya no se manda otro pago desde aquí.
    assert.equal((await reportarPortal(p, auth, folio)).status, 409);
    // /pedidos muestra quién mandó el pago por el nombre del socio, no por su id interno.
    const aparte = await socioConApartado(p, 'uid-b', '+524443334444');
    await reportarPortal(p, aparte.auth, aparte.folio);
    const lista = (await p.pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos as any[];
    const reporte = lista.find((x) => x.folio === aparte.folio).reporte;
    assert.deepEqual([reporte.revendedora, reporte.desde_portal], ['Cliente', 1]);
  } finally { p.cerrar(); }
});

test('el socio también paga en línea lo que levantó otra cuenta a su teléfono (revendedora), y la revendedora sigue reportando lo suyo', async () => {
  const p = portalDePrueba();
  try {
    const ANA = 'ana@revende.mx';
    p.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Ana R.', 'revendedora', 1, '', '')").run(ANA);
    await p.registrar('uid-a', '+524441112222');
    const auth = token('uid-a', '+524441112222');
    const pieza = piezaVendible(p);
    (p.env as any).DEV_USUARIO = ANA;
    const ap = await p.pedir('/api/vender/apartar', { id: crypto.randomUUID(), lineas: [{ producto_id: pieza.id, cantidad: 1 }], cliente: 'Lucía', telefono: '4441112222', entrega: 'tienda' });
    assert.equal(ap.status, 201, JSON.stringify(ap.cuerpo));
    const folio = ap.cuerpo.pedido.folio;
    // Lo ve el socio (por teléfono) pero no es cancelable desde el portal; sí puede mandar su pago.
    const vista = ((await p.llamar('/api/portal/apartados', auth)).body.apartados as any[])[0];
    assert.deepEqual([vista.folio, vista.cancelable], [folio, false]);
    assert.equal((await reportarPortal(p, auth, folio)).status, 201);
    // La revendedora ve el reporte pendiente de su venta y no puede mandar otro encima.
    const suyos = (await p.pedir('/api/vender/mios', undefined, 'GET')).cuerpo.pedidos as any[];
    assert.equal(suyos[0].pago_reportado.estado, 'pendiente');
    assert.equal((await p.pedir(`/api/vender/apartados/${folio}/pago`, { id: crypto.randomUUID(), clave_rastreo: claveUnica() })).status, 409);
  } finally { p.cerrar(); }
});
