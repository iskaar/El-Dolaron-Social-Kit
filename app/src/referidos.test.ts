// node --test src/referidos.test.ts
// Referidos Dolarones (Issue #489) contra SQLite real y todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './worker.ts';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';
import { codigoReferido, numeroDeCodigo } from './referidos.ts';

const codificar = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = (uid: string, phone: string) => {
  const now = Math.floor(Date.now() / 1000);
  return `${codificar({ alg: 'RS256' })}.${codificar({
    aud: 'prueba-firebase', iss: 'https://securetoken.google.com/prueba-firebase', sub: uid,
    exp: now + 3600, iat: now, auth_time: now, phone_number: phone, firebase: { sign_in_provider: 'phone' },
  })}.firma`;
};
const tel = (n: number) => `+52444000${String(n).padStart(4, '0')}`;

function montar(abierto = 'si') {
  const { db, env, pedir } = tienda();
  Object.assign(env, { HOST_PORTAL: 'portal.prueba', FIREBASE_PROJECT_ID: 'prueba-firebase',
    FIREBASE_WEB_API_KEY: 'clave', REFERIDOS_ABIERTO: abierto });
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const t = JSON.parse(String(options?.body ?? '{}')).idToken as string;
    const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) as { sub: string; phone_number: string };
    return Response.json({ users: [{ localId: c.sub, phoneNumber: c.phone_number }] });
  };
  const llamar = async (ruta: string, uid: string, telefono: string, body?: unknown, method = 'GET') => {
    const r = await worker.fetch!(new Request(`https://portal.prueba${ruta}`, {
      method, headers: { authorization: `Bearer ${token(uid, telefono)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never, env, { waitUntil() {} } as never);
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  // n = teléfono 4440000nnn; uid = u<n>. El 1 es el referente.
  const registrar = (n: number, codigo?: string) => llamar('/api/portal/registro', `u${n}`, tel(n), {
    nombre: 'Cliente', acepta_bases: true, declara_mayor_edad: true, bases_version: 'prueba-1',
    ...(codigo === undefined ? {} : { referido_codigo: codigo }),
  }, 'POST');
  const lotes = (id: string) => db.prepare('select origen, importe, restante from dolarones_lotes where cliente_id = ? order by creado_en, rowid').all(id) as
    { origen: string; importe: number; restante: number }[];
  const precio = (centavos: number) => db.prepare('update productos set precio = ? where id = ?').run(centavos, PRODUCTO);
  const comprar = (clienteId: string, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    return pedir('/api/ventas', { id, cliente_id: clienteId, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 100_000, ...extra }).then((r) => ({ ...r, id }));
  };
  const estado = (nuevo: string) => db.prepare('select estado, venta_id from referidos where nuevo_id = ?').get(nuevo) as { estado: string; venta_id: string | null };
  return { db, env, pedir, llamar, registrar, lotes, precio, comprar, estado,
    cerrar: () => { globalThis.fetch = fetchOriginal; db.close(); } };
}

test('el código sale del número de socio, detecta errores de dedo y no usa azar', () => {
  assert.equal(codigoReferido(42), codigoReferido(42));
  assert.match(codigoReferido(42), /^DOL42[A-HJ-NP-Z]$/);
  for (const n of [1, 7, 42, 100, 99999]) assert.equal(numeroDeCodigo(codigoReferido(n)), n);
  const bueno = codigoReferido(42);
  assert.equal(numeroDeCodigo(` ${bueno.toLowerCase().slice(0, 4)}-${bueno.slice(4)} `), 42);
  assert.equal(numeroDeCodigo(bueno.slice(0, -1) + (bueno.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(numeroDeCodigo('DOL43' + bueno.slice(-1)), null);
  for (const malo of ['', 'DOL', 'DOL0A', '42', 'xyz', null, undefined]) assert.equal(numeroDeCodigo(malo), null);
});

test('sin REFERIDOS_ABIERTO el programa está apagado: el código se rechaza y no hay pantalla', async () => {
  const p = montar('');
  try {
    assert.equal((await p.llamar('/api/portal/config', '', '')).body.referidos, false);
    assert.equal((await p.registrar(1)).status, 200);
    assert.equal((await p.registrar(2, codigoReferido(1))).status, 400);
    assert.equal(p.db.prepare('select count(*) as n from clientes').get()!.n, 1);
    const r = await p.llamar('/api/portal/referidos', 'u1', tel(1));
    assert.equal(r.body.habilitado, false);
    assert.equal(r.body.codigo, null);
  } finally { p.cerrar(); }
});

test('alta con código: 50 D a 30 días; sin código, inválido, o propio no dan nada', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    assert.equal((await p.llamar('/api/portal/config', '', '')).body.referidos, true);
    const codigo = codigoReferido(a.numero);

    const b = await p.registrar(2, codigo.toLowerCase());
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.referido_otorgado, 50_00);
    const lote = p.lotes(b.body.id).find((l) => l.origen === 'referido')!;
    assert.deepEqual([lote.importe, lote.restante], [50_00, 50_00]);
    const vence = p.db.prepare("select vence_en, disponible_desde from dolarones_lotes where origen = 'referido'").get()!;
    assert.equal(Math.round((Date.parse(vence.vence_en as string) - Date.parse(vence.disponible_desde as string)) / 86_400_000), 30);
    assert.equal(p.db.prepare("select count(*) as n from dolarones_movimientos where tipo = 'alta_referido'").get()!.n, 1);
    assert.equal(p.estado(b.body.id).estado, 'pendiente');

    // Reintento del mismo UID: mismo socio, sin segundo regalo ni segunda fila.
    assert.equal((await p.registrar(2, codigo)).body.referido_otorgado, 0);
    assert.equal(p.lotes(b.body.id).filter((l) => l.origen === 'referido').length, 1);

    // Sin código: solo el regalo de apertura. Código inválido: no crea socio.
    assert.equal((await p.registrar(3)).body.referido_otorgado, 0);
    for (const malo of ['DOL999Z', 'basura', codigo.slice(0, -1) + (codigo.endsWith('A') ? 'B' : 'A')]) {
      assert.equal((await p.registrar(4, malo)).status, 400, malo);
    }
    assert.equal(p.db.prepare("select count(*) as n from clientes where telefono = '4440000004'").get()!.n, 0);

    // Auto-referido: otro UID con el MISMO teléfono del referente, o su propio código ya registrado.
    const propio = await p.llamar('/api/portal/registro', 'otro-uid', tel(1), {
      nombre: 'Yo', acepta_bases: true, declara_mayor_edad: true, bases_version: 'prueba-1', referido_codigo: codigo }, 'POST');
    assert.equal(propio.status, 400);
    assert.match(propio.body.error, /propio/);
    assert.equal((await p.registrar(1, codigo)).body.referido_otorgado, 0);
    assert.equal(p.db.prepare('select count(*) as n from referidos').get()!.n, 1);
    assert.throws(() => p.db.prepare(`insert into referidos (nuevo_id, referente_id, creado_en) values (?, ?, '')`).run(a.id, a.id));

    // Lo que ve el portal.
    const r = (await p.llamar('/api/portal/referidos', 'u1', tel(1))).body;
    assert.deepEqual([r.codigo, r.referidos, r.liberados, r.pendientes, r.maximo], [codigo, 1, 0, 1, 10]);
    const mio = (await p.llamar('/api/portal/referidos', 'u2', tel(2))).body;
    assert.equal(mio.codigo, codigoReferido(b.body.numero));
    assert.deepEqual(mio.mi_referido, { estado: 'pendiente' });

    // Sin lista ni compra previa: quien se acaba de registrar ya puede referir.
    const c = await p.registrar(5, mio.codigo);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.referido_otorgado, 50_00);
    assert.equal((await p.llamar('/api/portal/referidos', 'u2', tel(2))).body.referidos, 1);
  } finally { p.cerrar(); }
});

test('tope de 10 por número: la persona 11 no recibe nada, ni siquiera el socio', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    const codigo = codigoReferido(a.numero);
    for (let n = 2; n <= 11; n++) assert.equal((await p.registrar(n, codigo)).status, 200, String(n));
    const clientes = p.db.prepare('select count(*) as n from clientes').get()!.n;
    const once = await p.registrar(12, codigo);
    assert.equal(once.status, 409);
    assert.equal(p.db.prepare('select count(*) as n from clientes').get()!.n, clientes);
    // Y sin código sí se puede registrar.
    assert.equal((await p.registrar(12)).status, 200);
    // Aunque la lectura previa se salte (carrera), el trigger deshace el batch.
    const nuevo = crypto.randomUUID();
    p.db.prepare(`insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en)
      values (?, 99, 'x', '4449999999', 'v', 'prueba', '')`).run(nuevo);
    assert.throws(() => p.db.prepare(`insert into referidos (nuevo_id, referente_id, creado_en) values (?, ?, '')`).run(nuevo, a.id), /tope de referidos/);
    const r = (await p.llamar('/api/portal/referidos', 'u1', tel(1))).body;
    assert.deepEqual([r.referidos, r.pendientes], [10, 10]);
  } finally { p.cerrar(); }
});

test('libera 25 + 25 con $150 en dinero, una sola vez, y no con $149.99', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    const b = (await p.registrar(2, codigoReferido(a.numero))).body;
    const premios = (id: string) => p.lotes(id).filter((l) => l.origen === 'referido' && l.importe === 25_00).length;

    p.precio(149_99);
    const corta = await p.comprar(b.id);
    assert.equal(corta.status, 201);
    assert.equal(corta.cuerpo.referido_liberado, 0);
    assert.equal(p.estado(b.id).estado, 'pendiente');

    p.precio(150_00);
    // Una compra encolada sin red (hora de hace 2 h) libera igual: la regla usa solo importes.
    const buena = await p.comprar(b.id, { creado_en: new Date(Date.now() - 7_200_000).toISOString() });
    assert.equal(buena.status, 201, JSON.stringify(buena.cuerpo));
    assert.equal(buena.cuerpo.referido_liberado, 25_00);
    assert.equal(p.estado(b.id).estado, 'liberado');
    assert.equal(p.estado(b.id).venta_id, buena.id);
    assert.equal(premios(a.id), 1);
    assert.equal(premios(b.id), 1);
    const tipos = p.db.prepare(`select cliente_id, tipo, importe from dolarones_movimientos where venta_id = ? and tipo like 'referido%' order by tipo`).all(buena.id).map((f) => ({ ...f }));
    assert.deepEqual(tipos, [{ cliente_id: a.id, tipo: 'referido', importe: 25_00 }, { cliente_id: b.id, tipo: 'referido_nuevo', importe: 25_00 }]);
    const premio = p.db.prepare("select disponible_desde, vence_en from dolarones_lotes where cliente_id = ? and importe = 2500").get(a.id)!;
    assert.ok(Date.parse(premio.disponible_desde as string) > Date.now());
    assert.ok(Date.parse(premio.vence_en as string) > Date.now() + 360 * 86_400_000);
    const por = (await p.llamar('/api/portal/saldo', 'u1', tel(1))).body;
    assert.equal(por.por_liberar, 25_00);

    // Reintento del mismo folio: responde la venta original, no paga otra vez.
    const otra = await p.pedir('/api/ventas', { id: buena.id, cliente_id: b.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 100_000, creado_en: p.db.prepare('select creado_en from ventas where id = ?').get(buena.id)!.creado_en });
    assert.equal(otra.cuerpo.duplicada, true);
    assert.equal(otra.cuerpo.referido_liberado, 25_00);
    // Otra compra grande: ya no hay nada que liberar.
    assert.equal((await p.comprar(b.id)).cuerpo.referido_liberado, 0);
    assert.equal(premios(a.id), 1);
    assert.equal(premios(b.id), 1);
    assert.equal((await p.llamar('/api/portal/referidos', 'u1', tel(1))).body.liberados, 1);
    assert.deepEqual((await p.llamar('/api/portal/referidos', 'u2', tel(2))).body.mi_referido, { estado: 'liberado' });
  } finally { p.cerrar(); }
});

test('los Dolarones usados no cuentan para el mínimo de $150', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    const codigo = codigoReferido(a.numero);
    const b = (await p.registrar(2, codigo)).body;
    const c = (await p.registrar(3, codigo)).body;
    // $199.99 pagando 50 D: $149.99 en dinero, no libera. Los 50 D de la alta sí se pueden gastar ahí.
    p.precio(199_99);
    const casi = await p.comprar(b.id, { dolarones: 50_00, codigo_socio: await codigoPrueba(p.db, b.id), efectivo: 149_99 });
    assert.equal(casi.status, 201, JSON.stringify(casi.cuerpo));
    assert.equal(casi.cuerpo.referido_liberado, 0);
    assert.equal(p.lotes(b.id).find((l) => l.importe === 50_00)!.restante, 0);
    // $200 pagando 50 D: $150 en dinero, sí libera en esa misma compra.
    p.precio(200_00);
    const justo = await p.comprar(c.id, { dolarones: 50_00, codigo_socio: await codigoPrueba(p.db, c.id), efectivo: 150_00 });
    assert.equal(justo.status, 201, JSON.stringify(justo.cuerpo));
    assert.equal(justo.cuerpo.referido_liberado, 25_00);
    assert.equal(p.estado(c.id).estado, 'liberado');
    assert.equal(p.estado(b.id).estado, 'pendiente');
  } finally { p.cerrar(); }
});

test('cancelar el ticket que liberó retira los 25 + 25 y deja al referido pendiente para otra compra', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    const b = (await p.registrar(2, codigoReferido(a.numero))).body;
    p.precio(150_00);
    const primera = await p.comprar(b.id);
    assert.equal(primera.cuerpo.referido_liberado, 25_00);
    const cancelada = await p.pedir(`/api/ventas/${primera.id}/cancelar`, { motivo: 'prueba' });
    assert.equal(cancelada.status, 200, JSON.stringify(cancelada.cuerpo));
    assert.equal(p.estado(b.id).estado, 'pendiente');
    assert.equal(p.estado(b.id).venta_id, null);
    for (const id of [a.id, b.id]) assert.equal(p.lotes(id).find((l) => l.importe === 25_00)!.restante, 0);
    assert.equal(p.db.prepare("select sum(importe) as n from dolarones_movimientos where cliente_id = ? and tipo like '%referido%'").get(a.id)!.n, 0);

    // Se puede liberar con otra compra, y es la única que paga.
    const segunda = await p.comprar(b.id);
    assert.equal(segunda.cuerpo.referido_liberado, 25_00);
    assert.equal(p.estado(b.id).venta_id, segunda.id);
    assert.equal(p.lotes(a.id).filter((l) => l.importe === 25_00 && l.restante === 25_00).length, 1);
  } finally { p.cerrar(); }
});

test('si ya se gastó lo liberado, cancelar el ticket no procede (mismo criterio que lo ganado, #135)', async () => {
  const p = montar();
  try {
    const a = (await p.registrar(1)).body;
    const b = (await p.registrar(2, codigoReferido(a.numero))).body;
    p.precio(150_00);
    const primera = await p.comprar(b.id);
    p.db.prepare("update dolarones_lotes set disponible_desde = '2026-01-01' where importe = 2500").run();
    p.precio(100_00);
    assert.equal((await p.comprar(a.id, { dolarones: 10_00, codigo_socio: await codigoPrueba(p.db, a.id), efectivo: 90_00 })).status, 201);
    const r = await p.pedir(`/api/ventas/${primera.id}/cancelar`, { motivo: 'prueba' });
    assert.equal(r.status, 409);
    assert.equal(p.db.prepare('select cancelada from ventas where id = ?').get(primera.id)!.cancelada, 0);
    assert.equal(p.estado(b.id).estado, 'liberado');
    assert.equal(p.lotes(b.id).find((l) => l.importe === 25_00)!.restante, 25_00);
  } finally { p.cerrar(); }
});

test('portal.js solo usa ids que existen en portal.html (campo de código y sección de referidos)', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const usados = [...new Set([...readFileSync('public/portal.js', 'utf8').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(usados.includes('referido') && usados.includes('ref-copiar'));
  assert.deepEqual(usados.filter((id) => !html.includes(`id="${id}"`)), []);
});

test('la caja muestra el premio de referido en el cobro, con y sin red (los tres caminos y la sincronización)', () => {
  const caja = readFileSync('public/caja.html', 'utf8');
  assert.equal(caja.match(/venta\.referido_liberado = cuerpo\.referido_liberado \?\? 0;/g)?.length, 3);
  assert.match(caja, /venta\.referido_liberado > 0 \? ` · \$\{avisoReferido\(venta\.referido_liberado\)\}`/);
  assert.match(caja, /cuerpo\.referido_liberado > 0 \? ` \$\{avisoReferido\(cuerpo\.referido_liberado\)\}\.`/);
  assert.match(caja, /Referido: \+\$\{dolares\(centavos\)\} para el cliente y para quien lo invitó/);
});
