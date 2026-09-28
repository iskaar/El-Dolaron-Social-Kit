// node --test src/dolarones.test.ts
// Dolarones contra SQLite real con el esquema y TODAS las migraciones (ver
// prueba-d1.ts): los triggers y el batch son los que cuidan el saldo, asi que
// se prueban ellos, no un simulacro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { regaloPara, REGALO, repartir, disponibleDesde, sumarMeses, sentenciasDeVenta } from './dolarones.ts';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';

let telefonos = 4440000000;
const alta = (pedir: ReturnType<typeof tienda>['pedir'], extra: Record<string, unknown> = {}) =>
  pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: String(telefonos++), pin: '1234', acepta_bases: true, ...extra,
  });

const venta = (extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, ...extra,
});

/* ---------- reglas puras ---------- */

test('el regalo reparte exactamente 15,000 D entre los primeros 100', () => {
  let suma = 0;
  for (let n = 1; n <= 100; n++) suma += regaloPara(n);
  assert.equal(suma, 15_000_00);
  assert.equal(regaloPara(1), 500_00);
  assert.equal(regaloPara(11), 300_00);
  assert.equal(regaloPara(12), 200_00);
  assert.equal(regaloPara(101), 0);
  assert.equal(REGALO.at(-1)!.hasta, 100);
});

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

/* ---------- contra la base ---------- */

test('altas en orden: numero consecutivo, regalo, telefono unico y reintento idempotente', async () => {
  const { pedir } = tienda();
  const primero = await alta(pedir, { telefono: '4441112222' });
  assert.equal(primero.status, 201);
  assert.equal(primero.cuerpo.numero, 1);
  assert.equal(primero.cuerpo.regalo, 500_00);
  assert.equal(primero.cuerpo.disponible, 500_00);

  const reintento = await pedir('/api/socios', {
    id: primero.cuerpo.id, nombre: 'Cliente', telefono: '4441112222', pin: '1234', acepta_bases: true,
  });
  assert.equal(reintento.cuerpo.numero, 1);

  const repetido = await alta(pedir, { telefono: '444-111-2222' });
  assert.equal(repetido.status, 409);

  const sinBases = await alta(pedir, { acepta_bases: false });
  assert.equal(sinBases.status, 400);

  const segundo = await alta(pedir);
  assert.equal(segundo.cuerpo.numero, 2);
  assert.equal(segundo.cuerpo.regalo, 300_00);

  const buscado = await pedir('/api/socios?q=444-111-2222');
  assert.equal(buscado.cuerpo.numero, 1);
  assert.equal((await pedir('/api/socios?q=2')).cuerpo.numero, 2);
});

test('101 altas: 15,000 D en regalos y el #101 sin regalo', async () => {
  const { db, pedir } = tienda();
  for (let i = 0; i < 101; i++) assert.equal((await alta(pedir)).status, 201);
  const { suma } = db.prepare(`select sum(importe) as suma from dolarones_lotes where origen = 'regalo'`).get() as { suma: number };
  assert.equal(suma, 15_000_00);
  assert.equal((await pedir('/api/socios?q=101')).cuerpo.disponible, 0);
});

test('comprar $250 gana 20 D, que se liberan hasta manana', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const r = await pedir('/api/ventas', venta({ cliente_id: socio.id }));
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.ganados, 20_00);
  assert.deepEqual(r.cuerpo.saldo, { disponible: 500_00, por_liberar: 20_00, regalo_disponible: 500_00 });
});

test('regalos: $999.99 no alcanza; $1,000 y $1,000.01 antes de D si, con total del servidor', async () => {
  for (const total of [999_99, 1000_00, 1000_01]) {
    const { db, pedir } = tienda();
    const socio = (await alta(pedir)).cuerpo;
    db.prepare('update productos set precio = ? where id = ?').run(total, PRODUCTO);
    const r = await pedir('/api/ventas', venta({
      cliente_id: socio.id, dolarones: 500_00, pin: '1234', forma_pago: 'tarjeta',
      total: 1000_00, // Campo inventado: no puede sustituir el total real.
    }));
    assert.equal(r.status, total < 1000_00 ? 409 : 201, JSON.stringify(r.cuerpo));
    if (total < 1000_00) {
      assert.match(r.cuerpo.error, /1,000/);
      assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 0);
      assert.equal(db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 50);
      assert.equal((await pedir('/api/socios?q=1')).cuerpo.regalo_disponible, 500_00);
    } else {
      assert.equal(r.cuerpo.total, total);
      assert.equal(r.cuerpo.saldo.disponible, 0);
      assert.equal(r.cuerpo.ganados, 50_00); // $500 monetarios bastan: minimo sobre el ticket.
    }
    db.close();
  }
});

test('saldo mixto: una compra menor a $1,000 usa solo lo ganado, aunque el regalo venza antes', async () => {
  const { db, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id }))).status, 201);
  // Simular el dia siguiente para los 20 D ganados, sin alterar el regalo.
  db.prepare("update dolarones_lotes set disponible_desde = '2026-01-01' where origen = 'compra'").run();
  const v = venta({ cliente_id: socio.id, dolarones: 20_00, pin: '1234', efectivo: 230_00 });
  const r = await pedir('/api/ventas', v);
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.saldo.disponible, 500_00);
  assert.equal(r.cuerpo.saldo.regalo_disponible, 500_00);
  assert.equal(db.prepare("select sum(restante) as n from dolarones_lotes where origen = 'regalo'").get()!.n, 500_00);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 1_00, pin: '1234', efectivo: 249_00 }))).status, 409);
  // Cancelar devuelve al mismo origen: vuelve a ser gastable en un ticket pequeno.
  assert.equal((await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'prueba' })).status, 200);
  assert.equal((await pedir('/api/ventas', venta({ ...v, id: crypto.randomUUID() }))).status, 201);
});

test('pago parcial con Dolarones: descuenta el saldo, gana solo sobre el dinero y cuadra el corte', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  // $1,000: 120 D + $880 en efectivo. Gana 80 D.
  const r = await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 120_00, pin: '1234', efectivo: 880_00, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] }));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.cambio, 0);
  assert.equal(r.cuerpo.ganados, 80_00);
  assert.deepEqual(r.cuerpo.saldo, { disponible: 380_00, por_liberar: 80_00, regalo_disponible: 380_00 });

  const corte = (await pedir('/api/ventas')).cuerpo;
  assert.equal(corte.total, 880_00);          // el efectivo que debe haber en el cajon
  assert.equal(corte.dolarones, 120_00);
});

test('Dolarones sin PIN correcto, sin saldo o sin socio: nada cambia', async () => {
  const { db, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const stock = () => (db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;

  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 100_00, pin: '9999', efectivo: 150_00 }))).status, 403);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 250_00, pin: '1234', efectivo: 750_00, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] }))).status, 201);
  // Ya gasto 250 de 500: 300 mas no alcanzan (lo ganado aun no se libera).
  const sinSaldo = await pedir('/api/ventas', {
    ...venta({ cliente_id: socio.id, dolarones: 300_00, pin: '1234', efectivo: 700_00 }),
    lineas: [{ producto_id: PRODUCTO, cantidad: 4 }],
  });
  assert.equal(sinSaldo.status, 409);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 250_01, pin: '1234', efectivo: 0 }))).status, 400);
  assert.equal((await pedir('/api/ventas', venta({ dolarones: 100_00, efectivo: 150_00 }))).status, 400);
  assert.equal(stock(), 46);                   // solo la venta valida bajo existencia
});

test('cinco PIN incorrectos bloquean, aun con el PIN correcto', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  for (let i = 0; i < 5; i++) {
    assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '0000', efectivo: 240_00 }))).status, 403);
  }
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '1234', efectivo: 240_00 }))).status, 423);
});

test('un importe de Dolarones invalido tampoco se acepta en una venta sin socio', async () => {
  const { db, pedir } = tienda();
  for (const dolarones of [-100, 0.5, 'NaN', 'Infinity', 9007199254740992]) {
    const r = await pedir('/api/ventas', venta({ dolarones, forma_pago: 'tarjeta' }));
    assert.equal(r.status, 400, String(dolarones));
  }
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 0);
  assert.equal(db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 50);
});

test('los PIN incorrectos concurrentes cuentan y no sobrescriben el bloqueo', async () => {
  const { db, env, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const ahora = new Date();
  const intentar = (pin: string, momento = ahora) => sentenciasDeVenta(env, {
    ventaId: crypto.randomUUID(), clienteId: socio.id, dolarones: 10_00,
    pin, total: 1000_00, autor: DUENO, ahora: momento,
  });
  const resultados = await Promise.all(Array.from({ length: 7 }, () => intentar('0000')));
  assert.ok(resultados.every((r) => !r.ok));
  const bloqueo = db.prepare('select pin_fallos, pin_bloqueo from clientes where id = ?').get(socio.id);
  assert.equal(bloqueo!.pin_fallos, 0);
  assert.equal(bloqueo!.pin_bloqueo, new Date(ahora.getTime() + 15 * 60_000).toISOString());
  const correcto = await intentar('1234');
  assert.ok(!correcto.ok && correcto.status === 423);
  assert.equal((await pedir('/api/socios?q=1')).cuerpo.disponible, 500_00);
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 0);
  assert.equal(db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 50);

  const despues = new Date(ahora.getTime() + 15 * 60_000);
  assert.equal((await intentar('1234', despues)).ok, true);
  assert.equal((await intentar('0000', despues)).ok, false);
  assert.equal(db.prepare('select pin_fallos from clientes where id = ?').get(socio.id)!.pin_fallos, 1);
});

test('un PIN en vuelo respeta un bloqueo o restablecimiento posterior a su lectura', async () => {
  const { db, env, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const ahora = new Date();
  const intentar = (pin: string) => sentenciasDeVenta(env, {
    ventaId: crypto.randomUUID(), clienteId: socio.id, dolarones: 10_00,
    pin, total: 250_00, autor: DUENO, ahora,
  });
  // La lectura inicial ya ocurrio; el hash todavia no termino.
  const correcto = intentar('1234');
  const bloqueo = new Date(ahora.getTime() + 15 * 60_000).toISOString();
  db.prepare('update clientes set pin_bloqueo = ? where id = ?').run(bloqueo, socio.id);
  const r = await correcto;
  assert.ok(!r.ok && r.status === 423);

  db.prepare("update clientes set pin_bloqueo = '', pin_fallos = 4 where id = ?").run(socio.id);
  const incorrecto = intentar('0000');
  const anterior = intentar('1234');
  db.prepare("update clientes set pin_hash = 'restablecido', pin_fallos = 0 where id = ?").run(socio.id);
  assert.equal((await incorrecto).ok, false);
  assert.equal((await anterior).ok, false);
  const estado = db.prepare('select pin_fallos, pin_bloqueo from clientes where id = ?').get(socio.id);
  assert.equal(estado!.pin_fallos, 0);
  assert.equal(estado!.pin_bloqueo, '');
});

test('reenviar la misma venta no gasta ni gana dos veces', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const v = venta({ cliente_id: socio.id, dolarones: 50_00, pin: '1234', efectivo: 950_00, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] });
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  assert.equal((await pedir('/api/ventas', v)).cuerpo.duplicada, true);
  const s = (await pedir('/api/socios?q=1')).cuerpo;
  assert.equal(s.disponible, 450_00);
  assert.equal(s.por_liberar, 90_00);
});

test('dos cajas gastan el mismo saldo a la vez: solo una se confirma', async () => {
  const { db, env, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;   // 500 D
  const ahora = new Date();
  // Las dos leen el saldo antes de que cualquiera escriba.
  const [a, b] = await Promise.all([crypto.randomUUID(), crypto.randomUUID()].map((ventaId) =>
    sentenciasDeVenta(env, { ventaId, clienteId: socio.id, dolarones: 400_00, pin: '1234', total: 1000_00, autor: DUENO, ahora })));
  assert.ok(a.ok && b.ok);
  await env.DB.batch(a.sentencias);
  await assert.rejects(env.DB.batch(b.sentencias), /saldo insuficiente/);
  const { suma } = db.prepare("select sum(restante) as suma from dolarones_lotes where cliente_id = ? and origen = 'regalo'").get(socio.id) as { suma: number };
  assert.equal(suma, 100_00);
});

test('un lote vencido no se gasta', async () => {
  const { db, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  db.prepare(`update dolarones_lotes set vence_en = '2026-01-01T00:00:00.000Z' where cliente_id = ?`).run(socio.id);
  assert.equal((await pedir('/api/socios?q=1')).cuerpo.disponible, 0);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '1234', efectivo: 240_00 }))).status, 409);
});

test('cancelar regresa existencia y Dolarones, retira lo ganado y no se repite', async () => {
  const { db, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const v = venta({ cliente_id: socio.id, dolarones: 150_00, pin: '1234', efectivo: 850_00, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] });
  assert.equal((await pedir('/api/ventas', v)).status, 201);

  const cancelada = await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'prueba' });
  assert.equal(cancelada.status, 200);
  assert.equal(cancelada.cuerpo.devuelto, 850_00);   // en dinero; los 150 D regresan al saldo
  assert.equal(cancelada.cuerpo.dolarones, 150_00);

  const s = (await pedir('/api/socios?q=1')).cuerpo;
  assert.equal(s.disponible, 500_00);
  assert.equal(s.por_liberar, 0);
  assert.equal(s.regalo_disponible, 500_00);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 1_00, pin: '1234', efectivo: 249_00 }))).status, 409);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 50);

  assert.equal((await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'otra vez' })).cuerpo.ya_estaba, true);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 50);
  const { neto } = db.prepare('select sum(importe) as neto from dolarones_movimientos where cliente_id = ?').get(socio.id) as { neto: number };
  assert.equal(neto, 500_00);                         // la bitacora explica el saldo
});

test('el dueno cambia el PIN y desbloquea; un cajero no puede', async () => {
  const { db, env, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  for (let i = 0; i < 5; i++) await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '0000', efectivo: 240_00 }));
  assert.equal((await pedir('/api/socios/1/pin', { pin: '5678' })).status, 200);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '5678', efectivo: 990_00, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] }))).status, 201);

  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('caja@prueba.mx', 'Caja', 'cajero', 1, '', '')`).run();
  (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await pedir('/api/socios/1/pin', { pin: '1111' })).status, 403);
  assert.equal((await pedir('/api/socios?q=1')).status, 200);
});
