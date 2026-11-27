// node --test src/pago-mixto.test.ts
// Pago mixto en el servidor (Issue #956, PR A): venta, corte, devoluciones, cancelación, corrección y CSV contra SQLite real.
// Un ticket mixto es ventas.forma_pago = 'mixto': `efectivo` es la parte en efectivo, `cambio` = 0 y la parte en tarjeta se calcula.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';
import { mixtoValido } from '../public/venta.js';

type Pedir = ReturnType<typeof tienda>['pedir'];

// Ventas de $250 por pieza (el producto de prueba) en la Caja 1. Por omisión: $100 en efectivo y $150 con tarjeta.
const mixta = (pedir: Pedir, extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'mixto', efectivo: 10000, caja: 'Caja 1', ...extra,
  };
  return pedir('/api/ventas', venta).then((r) => ({ ...r, id: venta.id, venta }));
};
const vender = async (pedir: Pedir, extra: Record<string, unknown> = {}) => {
  const r = await mixta(pedir, extra);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.id;
};
const cortar = (pedir: Pedir, contado: number, terminal = 0) =>
  pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: contado, tarjeta_terminal: terminal, sin_efectivo: contado === 0 });
const devolverPieza = async (pedir: Pedir, id: string, extra: Record<string, unknown> = {}) => {
  const linea = (await pedir(`/api/ventas/${id}`)).cuerpo.lineas[0].id;
  return pedir(`/api/ventas/${id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'prueba', caja: 'Caja 1', ...extra });
};
const filasCsv = (texto: string) => texto.replace(/^﻿/, '').split('\r\n').map((f) => f.split(','));

test('mixtoValido: las dos partes llevan algo y el efectivo es entero', () => {
  assert.equal(mixtoValido({ total: 25000, efectivo: 10000 }), true);
  assert.equal(mixtoValido({ total: 25000, efectivo: 1 }), true);
  assert.equal(mixtoValido({ total: 25000, efectivo: 24999 }), true);
  for (const efectivo of [0, -100, 25000, 30000, 100.5, NaN, Infinity, '10000' as unknown as number, undefined as unknown as number])
    assert.equal(mixtoValido({ total: 25000, efectivo }), false, String(efectivo));
  assert.equal(mixtoValido({ total: 0, efectivo: 0 }), false, 'un ticket sin nada que cobrar no es mixto');
});

test('venta mixta: 201, forma mixto, efectivo guardado como la parte en efectivo y cambio 0', async () => {
  const { db, pedir } = tienda();
  const r = await mixta(pedir);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.total, 25000);
  assert.equal(r.cuerpo.cambio, 0);
  const v = db.prepare('select forma_pago, efectivo, cambio, total, dolarones, anticipo from ventas where id = ?').get(r.id);
  assert.deepEqual({ ...v }, { forma_pago: 'mixto', efectivo: 10000, cambio: 0, total: 25000, dolarones: 0, anticipo: 0 });
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 49);
});

test('venta mixta con efectivo 0, igual al total, mayor, no entero o sin número: 400 sin escribir nada', async () => {
  const { db, pedir } = tienda();
  for (const efectivo of [0, 25000, 30000, -5000, 100.5, '10000', null, undefined]) {
    const r = await mixta(pedir, { efectivo });
    assert.equal(r.status, 400, String(efectivo));
    assert.match(r.cuerpo.error, /^En «Mixto» el efectivo debe ser más de \$0 y menos de lo que se cobra; el resto va con tarjeta\.$/, String(efectivo));
  }
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 50);
});

test('el mixto se valida contra lo que se cobra: sin Dolarones ni anticipo', async () => {
  const { db, pedir } = tienda();
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true, declara_mayor_edad: true,
  })).cuerpo;
  assert.equal((await pedir('/api/portal/llegada', { codigo: await codigoPrueba(db, socio.id) })).status, 200);   // saldo de apertura
  const dos = { lineas: [{ producto_id: PRODUCTO, cantidad: 4 }], cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(db, socio.id) };
  // Ticket de $1,000 con $50 en Dolarones: se cobran $950; $950 en efectivo no deja nada para la tarjeta.
  const sinTarjeta = await mixta(pedir, { ...dos, efectivo: 95000 });
  assert.equal(sinTarjeta.status, 400, JSON.stringify(sinTarjeta.cuerpo));
  assert.match(sinTarjeta.cuerpo.error, /En «Mixto»/);
  const bien = await mixta(pedir, { ...dos, efectivo: 90000 });
  assert.equal(bien.status, 201, JSON.stringify(bien.cuerpo));
  assert.equal(bien.cuerpo.cambio, 0);
});

test('el mixto no se cobra desde el celular (imprimir_en): 400', async () => {
  const { db, pedir } = tienda();
  const r = await mixta(pedir, { imprimir_en: 'Caja 1' });
  assert.equal(r.status, 400);
  assert.match(r.cuerpo.error, /pago mixto no se cobra desde el celular/);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
});

test('mismo folio y mismo reparto: duplicada sin volver a descontar; otro reparto: 409', async () => {
  const { db, pedir } = tienda();
  const primera = await mixta(pedir);
  assert.equal(primera.status, 201);
  const otra = await pedir('/api/ventas', primera.venta);
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(otra.cuerpo.cambio, 0);
  const distinto = await pedir('/api/ventas', { ...primera.venta, efectivo: 12000 });
  assert.equal(distinto.status, 409);
  assert.match(distinto.cuerpo.error, /El folio ya pertenece a otra venta/);
  const v = db.prepare('select efectivo from ventas where id = ?').get(primera.id) as { efectivo: number };
  assert.equal(v.efectivo, 10000, 'el reparto original no cambia');
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 1);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 49);
});

test('el corte del mismo turno: la parte en efectivo al cajón y la parte en tarjeta a la tarjeta del sistema', async () => {
  const { pedir } = tienda();
  await vender(pedir);                                                    // $100 efectivo + $150 tarjeta
  await vender(pedir, { forma_pago: 'efectivo', efectivo: 25000 });       // +$250 efectivo, para comprobar que no se mezclan
  await vender(pedir, { forma_pago: 'tarjeta', efectivo: 0 });            // +$250 tarjeta
  const c = (await cortar(pedir, 85000, 40000)).cuerpo;                   // 500 + 100 + 250
  assert.equal(c.tickets, 3);
  assert.equal(c.efectivo_ventas, 35000);
  assert.equal(c.efectivo_esperado, 85000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.tarjeta_sistema, 40000);                                 // 150 + 250
  assert.equal(c.tarjeta_terminal, 40000);
  assert.equal(c.transferencias, 0);
});

test('una pieza devuelta de un mixto en el mismo turno sale en efectivo del cajón y la tarjeta del sistema no cambia', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir, { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 20000 });   // $500: $200 + $300
  const r = await devolverPieza(pedir, id);                                                              // sin devolver_en
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual(db.prepare('select forma_pago, importe from devoluciones').all().map((d) => ({ ...d })), [{ forma_pago: 'efectivo', importe: 25000 }]);
  // Aunque la caja pida devolver «a la forma de pago», un mixto no tiene una: sale en efectivo.
  const otro = await vender(pedir, { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 20000 });
  assert.equal((await devolverPieza(pedir, otro, { devolver_en: 'tarjeta' })).status, 201);
  assert.deepEqual(db.prepare('select forma_pago from devoluciones').all().map((d: any) => d.forma_pago), ['efectivo', 'efectivo']);

  // Cajón: 500 + 400 (partes en efectivo) - 500 devueltos = 400. Tarjeta: 300 + 300, sin tocar.
  const c = (await cortar(pedir, 40000, 60000)).cuerpo;
  assert.equal(c.efectivo_ventas, 40000);
  assert.equal(c.efectivo_devoluciones, 50000);
  assert.equal(c.efectivo_esperado, 40000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.tarjeta_sistema, 60000);
});

test('devolver una pieza de un mixto después de su corte: sale del cajón siguiente y la tarjeta no se mueve', async () => {
  const { pedir } = tienda();
  const id = await vender(pedir, { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 20000 });
  const primero = (await cortar(pedir, 70000, 30000)).cuerpo;               // 500 + 200
  assert.equal(primero.efectivo_esperado, 70000);
  assert.equal(primero.tarjeta_sistema, 30000);
  assert.equal((await devolverPieza(pedir, id)).status, 201);
  const siguiente = (await cortar(pedir, 25000)).cuerpo;                    // fondo 500 - 250 devueltos
  assert.equal(siguiente.efectivo_devoluciones, 25000);
  assert.equal(siguiente.efectivo_esperado, 25000);
  assert.equal(siguiente.tarjeta_sistema, 0);
  assert.equal(siguiente.diferencia, 0);
});

test('cancelar un mixto en otro turno resta las dos partes y avisa cuánto sale del cajón y cuánto se cancela en la terminal', async () => {
  const { pedir } = tienda();
  const id = await vender(pedir);                                           // $100 + $150
  assert.equal((await cortar(pedir, 60000, 15000)).cuerpo.diferencia, 0);
  const r = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.en_efectivo, 10000);
  assert.equal(r.cuerpo.en_tarjeta, 15000);
  const c = (await cortar(pedir, 40000)).cuerpo;                            // fondo 500 - 100
  assert.equal(c.efectivo_devoluciones, 10000);
  assert.equal(c.efectivo_esperado, 40000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.tarjeta_sistema, -15000);
});

test('un ticket sin mixto no estrena campos en su cancelación', async () => {
  const { pedir } = tienda();
  const id = await vender(pedir, { forma_pago: 'tarjeta', efectivo: 0 });
  const r = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(r.status, 200);
  assert.equal('en_efectivo' in r.cuerpo, false);
  assert.equal('en_tarjeta' in r.cuerpo, false);
});

test('cancelar un mixto con piezas devueltas (dinero o cupón): 409 y el ticket sigue vigente', async () => {
  const { db, pedir } = tienda();
  const dos = { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 20000 };
  const conDinero = await vender(pedir, dos);
  assert.equal((await devolverPieza(pedir, conDinero)).status, 201);
  const a = await pedir(`/api/ventas/${conDinero}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(a.status, 409);
  assert.equal(a.cuerpo.error, 'Este ticket mixto ya tiene piezas devueltas: devuelve lo que queda pieza por pieza.');

  const conCupon = await vender(pedir, dos);
  const linea = (await pedir(`/api/ventas/${conCupon}`)).cuerpo.lineas[0].id;
  const cupon = await pedir(`/api/ventas/${conCupon}/cupon`, { id: crypto.randomUUID(), lineas: [{ linea, cantidad: 1 }], motivo: 'prefiere cambio', caja: 'Caja 1' });
  assert.equal(cupon.status, 201, JSON.stringify(cupon.cuerpo));
  const b = await pedir(`/api/ventas/${conCupon}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(b.status, 409);
  assert.match(b.cuerpo.error, /^Este ticket mixto ya tiene piezas devueltas/);
  assert.deepEqual(db.prepare('select cancelada from ventas order by rowid').all().map((v: any) => v.cancelada), [0, 0]);
});

test('corregir la forma de pago de un mixto: 400 antes de escribir; y no se corrige hacia mixto', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const r = await pedir(`/api/ventas/${id}/corregir-pago`, { id: crypto.randomUUID(), forma_pago: 'tarjeta', motivo: 'Era con tarjeta', caja: 'Caja 1' });
  assert.equal(r.status, 400, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.error, 'Un ticket mixto no se corrige: cancélalo y vuelve a cobrar.');
  assert.equal((db.prepare('select count(*) as n from correcciones_pago').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select forma_pago from ventas where id = ?').get(id) as { forma_pago: string }).forma_pago, 'mixto');
  // El detalle no ofrece ninguna forma a la que corregirlo.
  assert.deepEqual((await pedir(`/api/ventas/${id}`)).cuerpo.corregible, []);

  const efectivo = await vender(pedir, { forma_pago: 'efectivo', efectivo: 25000 });
  const aMixto = await pedir(`/api/ventas/${efectivo}/corregir-pago`, { id: crypto.randomUUID(), forma_pago: 'mixto', motivo: 'Era mixto', caja: 'Caja 1' });
  assert.equal(aMixto.status, 400);
  assert.equal((db.prepare('select forma_pago from ventas where id = ?').get(efectivo) as { forma_pago: string }).forma_pago, 'efectivo');
});

test('una venta rechazada que era mixta se reporta (201) con su forma de pago', async () => {
  const { db, pedir } = tienda();
  const id = crypto.randomUUID();
  const r = await pedir(`/api/ventas/${id}/rechazo`, {
    forma_pago: 'mixto', efectivo: 10000, caja: 'Caja 1', motivo: 'Terminal sin conexión',
    lineas: [{ codigo: 'ED-000001', nombre: 'Ventilador', cantidad: 1, precio: 25000 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const fila = db.prepare('select forma_pago, efectivo, total from ventas_rechazadas where id = ?').get(id);
  assert.deepEqual({ ...fila }, { forma_pago: 'mixto', efectivo: 10000, total: 25000 });
});

test('tickets: el filtro «mixto» y tickets.csv con parte_efectivo y parte_tarjeta al final, solo en los mixtos', async () => {
  const { pedir, pedirTexto } = tienda();
  const mixto = await vender(pedir);
  const efectivo = await vender(pedir, { forma_pago: 'efectivo', efectivo: 25000 });
  const lista = (await pedir('/api/reportes/tickets?dias=7&forma_pago=mixto')).cuerpo.tickets.map((t: { id: string }) => t.id);
  assert.deepEqual(lista, [mixto]);

  const filas = filasCsv((await pedirTexto('/api/reportes/tickets.csv?dias=7')).texto);
  assert.deepEqual(filas[0].slice(0, 14), ['fecha', 'ticket', 'caja', 'cajero', 'forma_pago', 'estado', 'piezas', 'cantidad', 'total', 'devuelto',
    'dolarones', 'dolarones_devueltos', 'vendido', 'socio'], 'las columnas de siempre no se mueven');
  assert.deepEqual(filas[0].slice(14), ['parte_efectivo', 'parte_tarjeta']);
  const por = (id: string) => filas.find((f) => f[1] === id)!;
  assert.deepEqual([por(mixto)[4], ...por(mixto).slice(14)], ['mixto', '100.00', '150.00']);
  assert.deepEqual([por(efectivo)[4], ...por(efectivo).slice(14)], ['efectivo', '', '']);
  assert.equal(por(mixto).length, 16);
});
