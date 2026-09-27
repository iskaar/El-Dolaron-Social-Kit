// node --test src/corte.test.ts
// El corte y la lista de ventas cuentan por dia de la TIENDA (UTC-6), no por
// dia UTC (Issue #93): una venta de las 19:30 del 2 de octubre es del 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './worker.ts';

const venta = (creado_en: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
  forma_pago: 'efectivo', efectivo: 25000, creado_en, ...extra,
});

test('hoy en la tienda: a las 19:30 locales (01:30 UTC del dia siguiente) sigue siendo hoy', () => {
  assert.equal(hoyTienda(Date.parse('2026-10-03T01:30:00Z')), '2026-10-02');
  assert.equal(hoyTienda(Date.parse('2026-10-02T17:00:00Z')), '2026-10-02');
  assert.equal(hoyTienda(Date.parse('2026-10-03T06:00:00Z')), '2026-10-03');
});

test('el corte del 2 de octubre incluye lo vendido despues de las 18:00 locales y nada del 3', async () => {
  const { pedir } = tienda();
  assert.equal((await pedir('/api/ventas', venta('2026-10-02T17:00:00.000Z'))).status, 201); // 11:00 del 2
  assert.equal((await pedir('/api/ventas', venta('2026-10-03T01:30:00.000Z'))).status, 201); // 19:30 del 2
  assert.equal((await pedir('/api/ventas', venta('2026-10-03T07:00:00.000Z'))).status, 201); // 01:00 del 3

  const corte = (await pedir('/api/ventas?dia=2026-10-02')).cuerpo;
  assert.equal(corte.total, 50000);
  assert.equal(corte.piezas, 2);
  const lista = (await pedir('/api/ventas?lista=1&dia=2026-10-02')).cuerpo as unknown as unknown[];
  assert.equal(lista.length, 2);
  assert.equal((await pedir('/api/ventas?dia=2026-10-03')).cuerpo.total, 25000);
});

test('transferencia es forma de pago y va aparte en el corte', async () => {
  const { pedir } = tienda();
  assert.equal((await pedir('/api/ventas', venta('2026-10-02T17:00:00.000Z', { forma_pago: 'transferencia', efectivo: 0 }))).status, 201);
  assert.equal((await pedir('/api/ventas', venta('2026-10-02T17:05:00.000Z', { forma_pago: 'cheque' }))).status, 400);
  const corte = (await pedir('/api/ventas?dia=2026-10-02')).cuerpo;
  assert.deepEqual(corte.por_forma_pago.map((f: { forma_pago: string }) => f.forma_pago), ['transferencia']);
});
