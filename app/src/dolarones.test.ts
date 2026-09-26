// node --test src/dolarones.test.ts
// Dolarones contra SQLite real (node:sqlite) con el esquema y TODAS las
// migraciones: los triggers y el batch son los que cuidan el saldo, asi que se
// prueban ellos, no un simulacro. El shim de D1 es lo minimo que usa la app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.ts';
import { regaloPara, REGALO, repartir, disponibleDesde, sumarMeses, sentenciasDeVenta } from './dolarones.ts';

const DUENO = 'dueno@prueba.mx';
const PRODUCTO = 'a1111111-1111-4111-8111-111111111111';

function d1(db: DatabaseSync) {
  const preparar = (sql: string) => {
    let args: unknown[] = [];
    const s = {
      bind(...a: unknown[]) { args = a.map((x) => (x === undefined ? null : x)); return s; },
      async first() { return db.prepare(sql).get(...(args as never[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(args as never[])) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }; },
      ejecutar() { return db.prepare(sql).run(...(args as never[])); },
    };
    return s;
  };
  return {
    prepare: preparar,
    // D1: el batch entero se confirma o se deshace.
    async batch(sentencias: ReturnType<typeof preparar>[]) {
      db.exec('begin');
      try {
        const salida = sentencias.map((s) => s.ejecutar());
        db.exec('commit');
        return salida;
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    },
  };
}

function tienda() {
  const db = new DatabaseSync(':memory:');
  const archivos = ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()];
  for (const f of archivos) db.exec(readFileSync(f, 'utf8'));
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Isaac', 'dueno', 1, '', '')`).run(DUENO);
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
              values (?, 'ED-000001', 'Ventilador', 25000, 50, 'S40', '', '')`).run(PRODUCTO);
  const env = { DB: d1(db), ACCESS_EQUIPO: 'local', DEV_USUARIO: DUENO } as unknown as Env;
  const pedir = async (ruta: string, cuerpo?: unknown) => {
    const r = await worker.fetch!(
      new Request(`https://caja.prueba${ruta}`, cuerpo === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
      }) as never,
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return { status: r.status, cuerpo: (await r.json()) as Record<string, any> };
  };
  return { db, env, pedir };
}

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
    { id: 'compra', restante: 2000, disponible_desde: '2026-10-03T06:00:00.000Z', vence_en: '2027-10-02T00:00:00.000Z' },
    { id: 'regalo', restante: 10000, disponible_desde: '2026-10-02T00:00:00.000Z', vence_en: '2026-11-01T00:00:00.000Z' },
    { id: 'vencido', restante: 9999, disponible_desde: '2026-01-01T00:00:00.000Z', vence_en: '2026-10-01T00:00:00.000Z' },
    { id: 'manana', restante: 9999, disponible_desde: '2026-10-11T06:00:00.000Z', vence_en: '2027-10-10T00:00:00.000Z' },
  ];
  assert.deepEqual(repartir(lotes, 11000, ahora), [{ id: 'regalo', importe: 10000 }, { id: 'compra', importe: 1000 }]);
  assert.equal(repartir(lotes, 12001, ahora), null);
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
  assert.deepEqual(r.cuerpo.saldo, { disponible: 500_00, por_liberar: 20_00 });
});

test('pago parcial con Dolarones: descuenta el saldo, gana solo sobre el dinero y cuadra el corte', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  // $250: 120 D + $130 en efectivo. Gana 10 D (un bloque completo de $100).
  const r = await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 120_00, pin: '1234', efectivo: 130_00 }));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.cambio, 0);
  assert.equal(r.cuerpo.ganados, 10_00);
  assert.deepEqual(r.cuerpo.saldo, { disponible: 380_00, por_liberar: 10_00 });

  const corte = (await pedir('/api/ventas')).cuerpo;
  assert.equal(corte.total, 130_00);          // el efectivo que debe haber en el cajon
  assert.equal(corte.dolarones, 120_00);
});

test('Dolarones sin PIN correcto, sin saldo o sin socio: nada cambia', async () => {
  const { db, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const stock = () => (db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;

  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 100_00, pin: '9999', efectivo: 150_00 }))).status, 403);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 250_00, pin: '1234', efectivo: 0 }))).status, 201);
  // Ya gasto 250 de 500: 300 mas no alcanzan (lo ganado aun no se libera).
  const sinSaldo = await pedir('/api/ventas', {
    ...venta({ cliente_id: socio.id, dolarones: 300_00, pin: '1234', efectivo: 200_00 }),
    lineas: [{ producto_id: PRODUCTO, cantidad: 2 }],
  });
  assert.equal(sinSaldo.status, 409);
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 250_01, pin: '1234', efectivo: 0 }))).status, 400);
  assert.equal((await pedir('/api/ventas', venta({ dolarones: 100_00, efectivo: 150_00 }))).status, 400);
  assert.equal(stock(), 49);                   // solo la venta valida bajo existencia
});

test('cinco PIN incorrectos bloquean, aun con el PIN correcto', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  for (let i = 0; i < 5; i++) {
    assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '0000', efectivo: 240_00 }))).status, 403);
  }
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '1234', efectivo: 240_00 }))).status, 423);
});

test('reenviar la misma venta no gasta ni gana dos veces', async () => {
  const { pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;
  const v = venta({ cliente_id: socio.id, dolarones: 50_00, pin: '1234', efectivo: 200_00 });
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  assert.equal((await pedir('/api/ventas', v)).cuerpo.duplicada, true);
  const s = (await pedir('/api/socios?q=1')).cuerpo;
  assert.equal(s.disponible, 450_00);
  assert.equal(s.por_liberar, 20_00);
});

test('dos cajas gastan el mismo saldo a la vez: solo una se confirma', async () => {
  const { db, env, pedir } = tienda();
  const socio = (await alta(pedir)).cuerpo;   // 500 D
  const ahora = new Date();
  // Las dos leen el saldo antes de que cualquiera escriba.
  const [a, b] = await Promise.all([crypto.randomUUID(), crypto.randomUUID()].map((ventaId) =>
    sentenciasDeVenta(env, { ventaId, clienteId: socio.id, dolarones: 400_00, pin: '1234', total: 400_00, autor: DUENO, ahora })));
  assert.ok(a.ok && b.ok);
  await env.DB.batch(a.sentencias);
  await assert.rejects(env.DB.batch(b.sentencias), /saldo insuficiente/);
  const { suma } = db.prepare('select sum(restante) as suma from dolarones_lotes where cliente_id = ?').get(socio.id) as { suma: number };
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
  const v = venta({ cliente_id: socio.id, dolarones: 150_00, pin: '1234', efectivo: 100_00 });
  assert.equal((await pedir('/api/ventas', v)).status, 201);

  const cancelada = await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'prueba' });
  assert.equal(cancelada.status, 200);
  assert.equal(cancelada.cuerpo.devuelto, 100_00);   // en dinero; los 150 D regresan al saldo
  assert.equal(cancelada.cuerpo.dolarones, 150_00);

  const s = (await pedir('/api/socios?q=1')).cuerpo;
  assert.equal(s.disponible, 500_00);
  assert.equal(s.por_liberar, 0);
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
  assert.equal((await pedir('/api/ventas', venta({ cliente_id: socio.id, dolarones: 10_00, pin: '5678', efectivo: 240_00 }))).status, 201);

  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('caja@prueba.mx', 'Caja', 'cajero', 1, '', '')`).run();
  (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await pedir('/api/socios/1/pin', { pin: '1111' })).status, 403);
  assert.equal((await pedir('/api/socios?q=1')).status, 200);
});
