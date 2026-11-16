// node --test src/avisos-dueno.test.ts
// Issue #819: que el dueño se entere. (1) «Ayuda» responde con verdad, (2) el 409 por existencia nombra la pieza,
// (3) una venta cobrada sin red que el servidor rechaza queda registrada para el dueño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { permiso } from './cuentas.ts';

const PC = 'pc@prueba.mx';
const ANA = 'ana@prueba.mx';
const OTRA = 'b2222222-2222-4222-8222-222222222222';

function montar(tiendaPc = 'soledad') {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, tienda, creado_en, actualizado_en) values
    (?, 'Computadora', 'computadora', 1, '', ?, '', ''), (?, 'Ana', 'cajero', 1, '', '', '', '')`).run(PC, tiendaPc, ANA);
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Lámpara', 10000, 1, 'S40', '', '')`).run(OTRA);
  const correos: { to: string; text: string }[] = [];
  t.env.CORREO = { async send(m: { to: string; text: string }) { correos.push(m); return { messageId: 'x' }; } } as never;
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const entrar = async () => {
    como(DUENO);
    await t.pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
    como(PC);
    return (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token as string;
  };
  const venta = (token: string, lineas: { producto_id: string; cantidad: number }[], extra: Record<string, unknown> = {}) =>
    t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas, forma_pago: 'efectivo', efectivo: 100000, ...extra }, 'POST', { 'x-cajero': token });
  return { ...t, correos, como, entrar, venta };
}

/** Lo que la caja manda al reportar una venta rechazada: solo lo que el ticket ya contiene. */
const reporte = (extra: Record<string, unknown> = {}) => ({
  motivo: 'No hay existencia suficiente para completar la venta.', forma_pago: 'efectivo', efectivo: 35000, creado_en: '2026-11-16T15:30:00.000Z', caja: 'Salk 1',
  lineas: [{ codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 }, { codigo: 'ED-000002', nombre: 'Lámpara', precio: 10000, cantidad: 1 }],
  ...extra,
});

test('Ayuda: sin celulares con avisos ni correo que salga, la respuesta lo dice (503, push 0, correos 0) y no «avisada»', async () => {
  const t = montar();
  (t.env as unknown as { CORREO?: unknown }).CORREO = undefined;   // sin VAPID_JWK ni binding de correo
  t.como(ANA);
  const r = await t.pedir('/api/ayuda', { caja: 'Caja 2' });
  assert.equal(r.status, 503);
  assert.equal(r.cuerpo.ok, false);
  assert.equal(r.cuerpo.push, 0);
  assert.equal(r.cuerpo.correos, 0);
  assert.match(r.cuerpo.error, /No hay celulares con avisos activos/);
});

test('Ayuda: un correo que falla al enviarse tampoco cuenta como avisado', async () => {
  const t = montar();
  t.env.CORREO = { async send() { throw new Error('rechazado'); } } as never;
  t.como(ANA);
  const r = await t.pedir('/api/ayuda', { caja: 'Caja 2' });
  assert.equal(r.status, 503);
  assert.equal(r.cuerpo.correos, 0);
});

test('Ayuda: con el correo de respaldo enviado responde 200 con cuántos salieron, e incluye la tienda de la terminal (no la del navegador)', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  const r = await t.pedir('/api/ayuda', { caja: 'Salk 1', tienda: 'romero' }, 'POST', { 'x-cajero': token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo, { ok: true, push: 0, correos: 1, tienda: 'salk' });
  assert.equal(t.correos[0].to, DUENO);
  assert.equal(t.correos[0].text, 'Ana pide ayuda en Salk 1, Avenida Salk.');
});

test('409 por existencia en Soledad: nombra la pieza que falta, no la que sí alcanza, y el ticket no se registra', async () => {
  const t = montar();
  const token = await t.entrar();
  const r = await t.venta(token, [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: OTRA, cantidad: 2 }]);
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /^No hay existencia suficiente para completar la venta\. Quita Lámpara: ya no está disponible\.$/);
  assert.equal(r.cuerpo.codigo, 'ED-000002');
  assert.equal(r.cuerpo.nombre, 'Lámpara');
  assert.equal(r.cuerpo.producto_id, OTRA);
  assert.deepEqual(r.cuerpo.faltantes.map((f: { codigo: string }) => f.codigo), ['ED-000002']);
  assert.equal((t.db.prepare('select count(*) n from ventas').get() as { n: number }).n, 0);
  assert.equal((t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 50, 'lo que sí alcanzaba no se descontó');
});

test('409 por existencia: la misma pieza en dos renglones se suma', async () => {
  const t = montar();
  const token = await t.entrar();
  const r = await t.venta(token, [{ producto_id: OTRA, cantidad: 1 }, { producto_id: OTRA, cantidad: 1 }]);
  assert.equal(r.status, 409);
  assert.equal(r.cuerpo.faltantes.length, 1);
  assert.equal(r.cuerpo.codigo, 'ED-000002');
});

test('409 en una sucursal: la existencia que cuenta es la de esa tienda (Soledad tiene la pieza, Salk no) y el mensaje conserva su primera frase', async () => {
  const t = montar('salk');
  t.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 1, '')").run(OTRA);
  const token = await t.entrar();
  // La Lámpara sí hay en Salk (1); el Ventilador solo en Soledad (50): falta el Ventilador.
  const r = await t.venta(token, [{ producto_id: OTRA, cantidad: 1 }, { producto_id: PRODUCTO, cantidad: 1 }], { caja: 'Salk 1' });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /^No hay existencia suficiente en esta sucursal para completar la venta\. Quita Ventilador: ya no está disponible\.$/);
  assert.equal(r.cuerpo.codigo, 'ED-000001');
  assert.deepEqual(r.cuerpo.faltantes.map((f: { producto_id: string }) => f.producto_id), [PRODUCTO]);
});

test('Venta rechazada: se reporta una sola vez por folio; tienda y cajero salen de la sesión, no del cuerpo', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  const id = crypto.randomUUID();
  const hdr = { 'x-cajero': token };
  const r = await t.pedir(`/api/ventas/${id}/rechazo`, reporte({ tienda: 'romero', cajero: 'otro@prueba.mx', estado: 'resuelta' }), 'POST', hdr);
  assert.equal(r.status, 201);
  await t.esperar();
  const fila = t.db.prepare('select * from ventas_rechazadas where id = ?').get(id) as Record<string, unknown>;
  assert.equal(fila.tienda, 'salk');
  assert.equal(fila.cajero, ANA);
  assert.equal(fila.caja, 'Salk 1');
  assert.equal(fila.estado, 'pendiente');
  assert.equal(fila.total, 35000);
  assert.equal(fila.piezas, 2);
  assert.equal(fila.creado_en, '2026-11-16T15:30:00.000Z');
  assert.equal(t.correos.length, 1, 'el dueño recibe un solo aviso');
  assert.match(t.correos[0].text, /\$350\.00/);

  // Reintento del reporte (la caja no supo que llegó): sigue una fila y no vuelve a avisar.
  const otra = await t.pedir(`/api/ventas/${id}/rechazo`, reporte(), 'POST', hdr);
  assert.equal(otra.status, 200);
  await t.esperar();
  assert.equal((t.db.prepare('select count(*) n from ventas_rechazadas').get() as { n: number }).n, 1);
  assert.equal(t.correos.length, 1);

  // Una caja de otra tienda no se acepta como suya.
  const ajena = crypto.randomUUID();
  await t.pedir(`/api/ventas/${ajena}/rechazo`, reporte({ caja: 'Caja 1' }), 'POST', hdr);
  assert.equal((t.db.prepare('select caja from ventas_rechazadas where id = ?').get(ajena) as { caja: string }).caja, '');
});

test('Venta rechazada: reporte inválido se rechaza; sin PIN de cajero no se acepta; un folio ya registrado no se reporta', async () => {
  const t = montar('salk');
  t.como(PC);
  assert.equal((await t.pedir(`/api/ventas/${crypto.randomUUID()}/rechazo`, reporte())).status, 401);
  const token = await t.entrar();
  const hdr = { 'x-cajero': token };
  const id = crypto.randomUUID();
  assert.equal((await t.pedir('/api/ventas/no-es-uuid/rechazo', reporte(), 'POST', hdr)).status, 400);
  for (const mal of [{ lineas: [] }, { lineas: [{ nombre: 'x', cantidad: 0, precio: 1 }] }, { lineas: [{ nombre: 'x', cantidad: 1, precio: -5 }] },
    { forma_pago: 'cheque' }, { motivo: '' }])
    assert.equal((await t.pedir(`/api/ventas/${id}/rechazo`, reporte(mal), 'POST', hdr)).status, 400, JSON.stringify(mal));
  assert.equal((t.db.prepare('select count(*) n from ventas_rechazadas').get() as { n: number }).n, 0);

  t.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 3, '')").run(PRODUCTO);
  const real = crypto.randomUUID();
  assert.equal((await t.venta(token, [{ producto_id: PRODUCTO, cantidad: 1 }], { id: real, caja: 'Salk 1' })).status, 201);
  const ya = await t.pedir(`/api/ventas/${real}/rechazo`, reporte(), 'POST', hdr);
  assert.deepEqual(ya.cuerpo, { ok: true, registrada: true });
  assert.equal((t.db.prepare('select count(*) n from ventas_rechazadas').get() as { n: number }).n, 0);
});

test('Venta rechazada: solo el dueño la lista y la resuelve (con nota); resolver no toca existencias ni ventas', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  const id = crypto.randomUUID();
  await t.pedir(`/api/ventas/${id}/rechazo`, reporte(), 'POST', { 'x-cajero': token });
  assert.deepEqual(permiso('/api/ventas-rechazadas', 'GET'), []);
  assert.deepEqual(permiso(`/api/ventas-rechazadas/${id}/resolver`, 'POST'), []);

  // El cajero (PIN en la computadora) no la ve ni la resuelve.
  assert.equal((await t.pedir('/api/ventas-rechazadas', undefined, 'GET', { 'x-cajero': token })).status, 403);
  assert.equal((await t.pedir(`/api/ventas-rechazadas/${id}/resolver`, { nota: 'ya' }, 'POST', { 'x-cajero': token })).status, 403);

  t.como(DUENO);
  const lista = await t.pedir('/api/ventas-rechazadas', undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.length ?? (lista.cuerpo as unknown as unknown[]).length, 1);
  const [v] = lista.cuerpo as unknown as Record<string, any>[];
  assert.equal(v.id, id);
  assert.equal(v.tienda_nombre, 'Avenida Salk');
  assert.equal(v.cajero, ANA);
  assert.equal(v.forma_pago, 'efectivo');
  assert.equal(v.piezas, 2);
  assert.equal(v.registrada, false);
  assert.deepEqual(v.lineas[0], { codigo: 'ED-000001', nombre: 'Ventilador', cantidad: 1, precio: 25000 });

  const antes = (t.db.prepare('select (select count(*) from ventas) v, (select sum(stock) from productos) s').get());
  assert.equal((await t.pedir(`/api/ventas-rechazadas/${id}/resolver`, { nota: '  ' })).status, 400);
  assert.equal((await t.pedir(`/api/ventas-rechazadas/${id}/resolver`, { nota: 'Se repuso el dinero en el corte' })).status, 200);
  assert.equal((await t.pedir(`/api/ventas-rechazadas/${id}/resolver`, { nota: 'otra vez' })).status, 409);
  assert.equal((await t.pedir(`/api/ventas-rechazadas/${crypto.randomUUID()}/resolver`, { nota: 'x' })).status, 404);
  assert.deepEqual(t.db.prepare('select (select count(*) from ventas) v, (select sum(stock) from productos) s').get(), antes);
  const fila = t.db.prepare('select estado, nota, resuelta_por from ventas_rechazadas where id = ?').get(id);
  assert.deepEqual({ ...fila }, { estado: 'resuelta', nota: 'Se repuso el dinero en el corte', resuelta_por: DUENO });
  assert.equal(((await t.pedir('/api/ventas-rechazadas', undefined, 'GET')).cuerpo as unknown as unknown[]).length, 0);
});

test('Venta rechazada: si el reintento después sí entra, el dueño la ve marcada como registrada', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  const id = crypto.randomUUID();
  await t.pedir(`/api/ventas/${id}/rechazo`, reporte(), 'POST', { 'x-cajero': token });
  t.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 3, '')").run(PRODUCTO);
  assert.equal((await t.venta(token, [{ producto_id: PRODUCTO, cantidad: 1 }], { id, caja: 'Salk 1' })).status, 201);
  t.como(DUENO);
  const [v] = (await t.pedir('/api/ventas-rechazadas', undefined, 'GET')).cuerpo as unknown as { registrada: boolean }[];
  assert.equal(v.registrada, true);
});

test('caja: al rechazarse una venta sin red se queda con el motivo completo, se reporta con su folio y solo entonces se puede descartar', async () => {
  const fuente = readFileSync('public/caja.html', 'utf8');
  const texto = fuente.slice(fuente.indexOf('let sincronizando = false;'), fuente.indexOf('async function pendientes()'));
  const venta = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, creado_en: '2026-11-16T15:30:00.000Z', caja: 'Caja 1' };
  const cola = new Map<string, any>([[venta.id, venta]]);
  const llamadas: { url: string; cuerpo: any }[] = [];
  let reporteLlega = false;
  const motivo = 'No hay existencia suficiente para completar la venta. Quita Ventilador: ya no está disponible.';
  const sincronizar = runInNewContext(`${texto}; sincronizar`, {
    store: async (almacen: string, _modo: string, fn: any) => fn({
      getAll: () => almacen === 'ventas' ? [...cola.values()] : [], get: (id: string) => cola.get(id), delete: (id: string) => cola.delete(id), put: (x: any) => cola.set(x.id, x),
    }),
    fetch: async (url: string, init: any) => {
      if (url.endsWith('/rechazo')) {
        llamadas.push({ url, cuerpo: JSON.parse(init.body) });
        if (!reporteLlega) throw new TypeError('sin red');
        return { ok: true, status: 201, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 409, json: async () => ({ error: motivo, faltantes: [{ producto_id: PRODUCTO }] }) };
    },
    $: () => ({ textContent: '' }), dolares: String, AbortSignal, JSON, encodeURIComponent,
    pintarResultadosVales() {}, pendientes() {}, pintarRechazadas() {}, actualizarCorte() {},
  });
  await sincronizar();
  assert.equal(cola.get(venta.id).estado, 'rechazada');
  assert.equal(cola.get(venta.id).motivo, motivo, 'el motivo guardado conserva qué pieza quitar');
  assert.equal(cola.get(venta.id).reportada, undefined, 'sin red: no se da por avisado');
  assert.equal(llamadas.length, 1);

  reporteLlega = true;
  await sincronizar();   // la rechazada no se reenvía sola, pero el reporte pendiente sí se reintenta
  assert.equal(cola.get(venta.id).reportada, true);
  assert.equal(llamadas[1].url, `/api/ventas/${venta.id}/rechazo`);
  assert.deepEqual(llamadas[1].cuerpo.lineas, [{ codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 }]);
  assert.equal(llamadas[1].cuerpo.motivo, motivo);
  assert.equal(llamadas[1].cuerpo.forma_pago, 'efectivo');
  assert.equal('cliente_id' in llamadas[1].cuerpo, false, 'nada del cliente viaja en el reporte');
  await sincronizar();
  assert.equal(llamadas.length, 2, 'ya reportada: no se vuelve a enviar');
});
