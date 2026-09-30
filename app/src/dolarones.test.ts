// node --test src/dolarones.test.ts
// Dinero, lotes y autorización contra SQLite real y todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { repartir, disponibleDesde, sumarMeses, sentenciasDeVenta } from './dolarones.ts';
import { tienda, codigoPrueba, DUENO, PRODUCTO } from './prueba-d1.ts';

let telefonos = 4440000000;
const venta = (extra: Record<string, unknown> = {}) => ({
  id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:4 }],
  forma_pago:'efectivo', efectivo:1000_00, ...extra,
});
function abrir() {
  const t = tienda();
  const alta = async (extra: Record<string, unknown> = {}) => {
    const r = await t.pedir('/api/socios', { id:crypto.randomUUID(), nombre:'Cliente',
      telefono:String(telefonos++), acepta_bases:true, ...extra });
    if (r.status === 201) await t.pedir('/api/portal/llegada', { cliente_id:r.cuerpo.id });
    return r;
  };
  const pagar = async (socio: Record<string, any>, extra: Record<string, unknown> = {}) =>
    t.pedir('/api/ventas', venta({ cliente_id:socio.id,
      codigo_socio:extra.codigo_socio ?? await codigoPrueba(t.db, socio.id), ...extra }));
  return { ...t, alta, pagar };
}

/* ---------- reglas puras ---------- */

test('lo ganado se libera a la medianoche siguiente de la tienda (UTC-6)', () => {
  // 10:00 del 2 de oct en la tienda -> 00:00 del 3
  assert.equal(disponibleDesde(new Date('2026-10-02T16:00:00Z')), '2026-10-03T06:00:00.000Z');
  // 23:30 del 2 de oct en la tienda (ya es 3 en UTC) -> 00:00 del 3, no del 4
  assert.equal(disponibleDesde(new Date('2026-10-03T05:30:00Z')), '2026-10-03T06:00:00.000Z');
});

test('12 meses conservan la hora local y caen al ultimo dia si el dia no existe', () => {
  assert.equal(sumarMeses(new Date('2026-10-02T18:00:00Z'), 12), '2027-10-02T18:00:00.000Z');
  assert.equal(sumarMeses(new Date('2027-01-31T18:00:00Z'), 1), '2027-02-28T18:00:00.000Z');
  assert.equal(sumarMeses(new Date('2028-02-29T18:00:00Z'), 12), '2029-02-28T18:00:00.000Z');
});

test('el canje sale primero del lote que vence antes y no toca vencidos ni por liberar', () => {
  const ahora = '2026-10-10T00:00:00.000Z';
  const lotes = [
    { id: 'compra', origen: 'compra', restante: 2000, disponible_desde: '2026-10-03T06:00:00.000Z', vence_en: '2027-10-02T00:00:00.000Z' },
    { id: 'regalo', origen: 'regalo', restante: 10000, disponible_desde: '2026-10-02T00:00:00.000Z', vence_en: '2026-11-01T00:00:00.000Z' },
    { id: 'vencido', origen: 'compra', restante: 9999, disponible_desde: '2026-01-01T00:00:00.000Z', vence_en: '2026-10-01T00:00:00.000Z' },
    { id: 'manana', origen: 'compra', restante: 9999, disponible_desde: '2026-10-11T06:00:00.000Z', vence_en: '2027-10-10T00:00:00.000Z' },
  ];
  assert.deepEqual(repartir(lotes, 11000, ahora, 1000_00), [{ id: 'regalo', importe: 10000 }, { id: 'compra', importe: 1000 }]);
  assert.equal(repartir(lotes, 12001, ahora, 1000_00), null);
});


test('altas sin PIN: número, teléfono único, aceptación y reintento idempotente', async () => {
  const t = abrir();
  const primero = await t.alta({ telefono:'4441112222' });
  assert.equal(primero.status, 201);
  assert.equal(primero.cuerpo.numero, 1);
  const reintento = await t.pedir('/api/socios', { id:primero.cuerpo.id, nombre:'Cliente',
    telefono:'4441112222', acepta_bases:true });
  assert.equal(reintento.cuerpo.numero, 1);
  assert.equal((await t.alta({ telefono:'444-111-2222' })).status, 409);
  assert.equal((await t.alta({ acepta_bases:false })).status, 400);
  assert.equal((await t.alta()).cuerpo.numero, 2);
  assert.equal((await t.pedir('/api/socios?q=444-111-2222')).cuerpo.disponible, 500_00);
  assert.equal((await t.pedir('/api/socios/1/pin', { pin:'1234' })).status, 404);
  assert.ok(!(t.db.prepare('pragma table_info(clientes)').all() as { name:string }[]).some((c) => c.name.startsWith('pin_')));
  t.db.close();
});

test('51 llegadas: 7,700 D en 50 cupos presenciales y la #51 sin regalo', async () => {
  const t = abrir();
  for (let i = 0; i < 51; i++) assert.equal((await t.alta()).status, 201);
  assert.equal(t.db.prepare("select sum(importe) as suma from dolarones_lotes where origen='regalo'").get()!.suma, 7_700_00);
  assert.equal((await t.pedir('/api/socios?q=51')).cuerpo.disponible, 0);
  t.db.close();
});

test('comprar $250 gana 20 D disponibles mañana, sin exigir código para acumular', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const r = await t.pedir('/api/ventas', venta({ cliente_id:socio.id, lineas:[{ producto_id:PRODUCTO, cantidad:1 }], efectivo:25000 }));
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.ganados, 2000);
  assert.deepEqual(r.cuerpo.saldo, { disponible:50000, por_liberar:2000, regalo_disponible:50000 });
  t.db.close();
});

test('regalos: $999.99 falla; $1,000 y $1,000.01 cumplen con el total del servidor', async () => {
  for (const total of [99999, 100000, 100001]) {
    const t = abrir(), socio = (await t.alta()).cuerpo;
    t.db.prepare('update productos set precio = ? where id = ?').run(total, PRODUCTO);
    const r = await t.pagar(socio, { dolarones:50000, forma_pago:'tarjeta',
      total:100000, lineas:[{ producto_id:PRODUCTO, cantidad:1 }] });
    assert.equal(r.status, total < 100000 ? 409 : 201);
    if (total < 100000) {
      assert.match(r.cuerpo.error, /1,000/);
      assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
      assert.equal(t.db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 50);
    } else {
      assert.equal(r.cuerpo.total, total);
      assert.equal(r.cuerpo.saldo.disponible, 0);
      assert.equal(r.cuerpo.ganados, 5000);
    }
    t.db.close();
  }
});

test('saldo mixto: ticket menor al mínimo usa sólo compras y cancelar conserva ese origen', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  await t.pagar(socio, { lineas:[{ producto_id:PRODUCTO, cantidad:1 }], efectivo:25000 });
  t.db.prepare("update dolarones_lotes set disponible_desde = '2026-01-01' where origen='compra'").run();
  const v = venta({ cliente_id:socio.id, codigo_socio:await codigoPrueba(t.db, socio.id),
    dolarones:2000, efectivo:23000, lineas:[{ producto_id:PRODUCTO, cantidad:1 }] });
  const r = await t.pedir('/api/ventas', v);
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.saldo.regalo_disponible, 50000);
  assert.equal((await t.pagar(socio, { dolarones:100, efectivo:24900, lineas:[{ producto_id:PRODUCTO, cantidad:1 }] })).status, 409);
  assert.equal((await t.pedir('/api/ventas/' + v.id + '/cancelar', { motivo:'prueba' })).status, 200);
  assert.equal((await t.pagar(socio, { ...v, id:crypto.randomUUID(), codigo_socio:await codigoPrueba(t.db, socio.id) })).status, 201);
  t.db.close();
});

test('pago parcial: descuenta, gana sólo sobre dinero y cuadra corte', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const r = await t.pagar(socio, { dolarones:12000, efectivo:88000 });
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.cambio, 0);
  assert.equal(r.cuerpo.ganados, 8000);
  assert.deepEqual(r.cuerpo.saldo, { disponible:38000, por_liberar:8000, regalo_disponible:38000 });
  const corte = (await t.pedir('/api/ventas')).cuerpo;
  assert.equal(corte.total, 88000);
  assert.equal(corte.dolarones, 12000);
  t.db.close();
});

test('sin código, con PIN antiguo, sin saldo o sin socio: nada se gasta', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  assert.equal((await t.pedir('/api/ventas', venta({ cliente_id:socio.id, dolarones:10000, pin:'1234' }))).status, 403);
  assert.equal((await t.pagar(socio, { dolarones:25000 })).status, 201);
  assert.equal((await t.pagar(socio, { dolarones:30000 })).status, 409);
  assert.equal((await t.pagar(socio, { dolarones:100001, forma_pago:'tarjeta' })).status, 400);
  assert.equal((await t.pedir('/api/ventas', venta({ dolarones:10000 }))).status, 400);
  assert.equal(t.db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 46);
  t.db.close();
});

test('importes inválidos se rechazan incluso sin socio', async () => {
  const t = abrir();
  for (const dolarones of [-100, 0.5, 'NaN', 'Infinity', 9007199254740992])
    assert.equal((await t.pedir('/api/ventas', venta({ dolarones, forma_pago:'tarjeta' }))).status, 400);
  assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
  t.db.close();
});

test('reenviar la misma venta no consume ni gana dos veces; otro ticket no reutiliza el código', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const v = venta({ cliente_id:socio.id, codigo_socio:await codigoPrueba(t.db, socio.id), dolarones:5000 });
  assert.equal((await t.pedir('/api/ventas', v)).status, 201);
  assert.equal((await t.pedir('/api/ventas', v)).cuerpo.duplicada, true);
  assert.equal((await t.pedir('/api/ventas', { ...v, id:crypto.randomUUID() })).status, 403);
  const s = (await t.pedir('/api/socios?q=1')).cuerpo;
  assert.equal(s.disponible, 45000);
  assert.equal(s.por_liberar, 9000);
  t.db.close();
});

test('dos cajas leen el mismo código y saldo: sólo una confirma', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const codigo = await codigoPrueba(t.db, socio.id);
  const args = { clienteId:socio.id, dolarones:40000, codigo, total:100000, autor:DUENO, ahora:new Date() };
  const [a, b] = await Promise.all([crypto.randomUUID(), crypto.randomUUID()].map((ventaId) => sentenciasDeVenta(t.env, { ...args, ventaId })));
  assert.ok(a.ok && b.ok);
  await t.env.DB.batch(a.sentencias);
  await assert.rejects(t.env.DB.batch(b.sentencias), /codigo de socio invalido/);
  assert.equal(t.db.prepare("select sum(restante) as n from dolarones_lotes where origen='regalo'").get()!.n, 10000);
  t.db.close();
});

test('regenerar o revocar un código en vuelo aborta el batch completo', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  for (const modo of ['regenerar', 'revocar']) {
    const codigo = await codigoPrueba(t.db, socio.id);
    const r = await sentenciasDeVenta(t.env, { ventaId:crypto.randomUUID(), clienteId:socio.id,
      dolarones:10000, codigo, total:100000, autor:DUENO, ahora:new Date() });
    assert.ok(r.ok);
    if (modo === 'regenerar') await codigoPrueba(t.db, socio.id);
    else t.db.prepare("update codigos_cliente set expira_en='' where cliente_id=?").run(socio.id);
    await assert.rejects(t.env.DB.batch(r.sentencias), /codigo de socio invalido/);
    assert.equal((await t.pedir('/api/socios?q=1')).cuerpo.disponible, 50000);
  }
  t.db.close();
});

test('un fallo de existencias conserva autorización; un lote vencido nunca se gasta', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const v = venta({ cliente_id:socio.id, codigo_socio:await codigoPrueba(t.db, socio.id), dolarones:10000 });
  t.db.prepare('update productos set stock=2 where id=?').run(PRODUCTO);
  assert.equal((await t.pedir('/api/ventas', v)).status, 409);
  assert.equal(t.db.prepare('select venta_id from codigos_cliente').get()!.venta_id, '');
  t.db.prepare('update productos set stock=50 where id=?').run(PRODUCTO);
  assert.equal((await t.pedir('/api/ventas', v)).status, 201);
  t.db.prepare("update dolarones_lotes set vence_en='2020-01-01' where origen='regalo'").run();
  assert.equal((await t.pagar(socio, { dolarones:100 })).status, 409);
  t.db.close();
});

test('cancelar devuelve existencias y D, retira ganados y no reabre el código consumido', async () => {
  const t = abrir(), socio = (await t.alta()).cuerpo;
  const v = venta({ cliente_id:socio.id, codigo_socio:await codigoPrueba(t.db, socio.id), dolarones:15000, efectivo:85000 });
  assert.equal((await t.pedir('/api/ventas', v)).status, 201);
  const r = await t.pedir('/api/ventas/' + v.id + '/cancelar', { motivo:'prueba' });
  assert.equal(r.cuerpo.devuelto, 85000);
  assert.equal(r.cuerpo.dolarones, 15000);
  assert.equal((await t.pedir('/api/ventas', { ...v, id:crypto.randomUUID() })).status, 403);
  assert.equal((await t.pedir('/api/ventas/' + v.id + '/cancelar', { motivo:'prueba' })).cuerpo.ya_estaba, true);
  assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  assert.equal(t.db.prepare('select sum(importe) as neto from dolarones_movimientos').get()!.neto, 50000);
  t.db.close();
});
