import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { readFileSync } from 'node:fs';

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
  let validSince = 0;
  globalThis.fetch = async (_url, options) => {
    const t = JSON.parse(String(options?.body ?? '{}')).idToken as string;
    const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) as { sub: string; phone_number: string };
    return Response.json({ users: [{ localId: claims.sub, phoneNumber: claims.phone_number, validSince: String(validSince) }] });
  };
  const llamar = async (ruta: string, auth: string, body?: unknown, method = 'GET') => {
    const response = await worker.fetch!(new Request(`https://portal.prueba${ruta}`, {
      method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never, env, { waitUntil() {} } as never);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const registrar = (uid: string, phone: string) => llamar('/api/portal/registro', token(uid, phone), {
    nombre: 'Cliente', acepta_bases: true, declara_mayor_edad:true, bases_version: 'prueba-1',
  }, 'POST');
  return { db, env, pedir, llamar, registrar, setValidSince: (v: number) => { validSince = v; },
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
      return new Response(readFileSync('public/' + (ruta === '/portal' ? 'portal.html' : ruta.slice(1))),
        { headers:{ 'content-type':ruta === '/portal' ? 'text/html' : 'text/javascript' } });
    } } as unknown as Fetcher;
    for (const ruta of ['/', '/portal', '/portal.html', '/portal.js', '/portal.css', '/code128.js']) {
      const r = await worker.fetch!(new Request('https://portal.prueba' + ruta) as never, p.env, {} as never);
      assert.equal(r.status, 200, ruta);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      const cuerpo = await r.text();
      assert.ok(cuerpo.length);
    }
    for (const ruta of ['/caja', '/caja.html', '/admin', '/cuentas', '/socios', '/captura',
      '/cajero.js', '/venta.js', '/api/ventas', '/api/socios/codigo', '/api/socios/vincular',
      '/api/foto/123', '/api/portal/llegada', '/foo/portal.html'])
      assert.equal((await p.llamar(ruta, '')).status, 404, ruta);
    assert.equal(leidos.length, 6);
    assert.equal((await p.llamar('/portal.js', '', {}, 'POST')).status, 404);
    assert.equal((await p.pedir('/api/portal/config')).status, 404);
    const config = await p.llamar('/api/portal/config', '');
    assert.equal(config.status, 200);
    assert.ok(config.body.firebase);
    assert.equal(config.body.bases, 'Bases sintéticas de prueba.');
    p.env.PORTAL_AVISO_TEXTO = '';
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
