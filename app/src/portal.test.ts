import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

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
    nombre: 'Cliente', pin: '1234', acepta_bases: true, bases_version: 'prueba-1',
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
        telefono: `555${String(n).padStart(7, '0')}`, pin: '1234', acepta_bases: true });
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
    const venta = await p.pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: online.body.id,
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 90000,
      dolarones: 10000, pin: '1234' });
    assert.equal(venta.status, 201);
    assert.equal((await p.pedir('/api/portal/llegada', { cliente_id: online.body.id })).status, 409);
    const segundo = await p.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Otro',
      telefono: '5552223333', pin: '1234', acepta_bases: true });
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
      telefono: '5551112222', pin: '1234', acepta_bases: true });
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
