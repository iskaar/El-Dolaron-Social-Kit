// node --test src/devoluciones.test.ts
// Desglose del ticket y cancelacion por pieza (Issue #138) contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { repartirDevolucion } from './devoluciones.ts';

type Pedir = ReturnType<typeof tienda>['pedir'];

// Dos piezas de $250 del producto de prueba, en efectivo, en la Caja 1.
const vender = async (pedir: Pedir, extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }],
    forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', ...extra,
  };
  const r = await pedir('/api/ventas', venta);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return venta.id;
};
const detalle = async (pedir: Pedir, id: string) => (await pedir(`/api/ventas/${id}`)).cuerpo;
const cancelarPieza = (pedir: Pedir, ventaId: string, lineaId: number, extra: Record<string, unknown> = {}) =>
  pedir(`/api/ventas/${ventaId}/lineas/${lineaId}/cancelar`, {
    id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedo', caja: 'Caja 1', ...extra,
  });
const stock = (db: ReturnType<typeof tienda>['db']) =>
  (db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
const cortar = (pedir: Pedir, contado: number) =>
  pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: contado, tarjeta_terminal: 0 });

test('dinero primero: la pieza sale en dinero hasta lo cobrado en dinero, el resto en Dolarones', () => {
  const base = { pagado: 40000, devuelto: 0, dolarones: 10000, dolaronesDevueltos: 0 };
  assert.deepEqual(repartirDevolucion({ ...base, importe: 25000 }), { dinero: 25000, dolarones: 0 });
  assert.deepEqual(repartirDevolucion({ ...base, importe: 25000, devuelto: 25000 }), { dinero: 15000, dolarones: 10000 });
  assert.deepEqual(repartirDevolucion({ ...base, importe: 5000, devuelto: 40000, dolaronesDevueltos: 8000 }),
    { dinero: 0, dolarones: 2000 });
});

test('cancelar una pieza: regresa la existencia, deja huella y el corte resta solo esa pieza', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const antes = stock(db);
  const ticket = await detalle(pedir, id);
  assert.equal(ticket.lineas.length, 1);
  assert.equal(ticket.lineas[0].cantidad, 2);

  const r = await cancelarPieza(pedir, id, ticket.lineas[0].id);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(db), antes + 1);

  const despues = await detalle(pedir, id);
  assert.equal(despues.cancelada, 0);
  assert.equal(despues.devuelto, 25000);
  assert.equal(despues.lineas[0].cancelada_cantidad, 1);
  assert.equal(despues.devoluciones.length, 1);
  assert.equal(despues.devoluciones[0].motivo, 'no le quedo');
  assert.equal(despues.devoluciones[0].caja, 'Caja 1');

  // 500 de fondo + 500 cobrados - 250 devueltos
  const c = (await cortar(pedir, 75000)).cuerpo;
  assert.equal(c.efectivo_ventas, 50000);
  assert.equal(c.efectivo_devoluciones, 25000);
  assert.equal(c.diferencia, 0);

  // El dia de la caja y los reportes cuentan lo que quedo vendido.
  const dia = (await pedir('/api/ventas')).cuerpo;
  assert.equal(dia.total, 25000);
  assert.equal(dia.piezas, 1);
  const rep = (await pedir('/api/reportes')).cuerpo;
  assert.equal(rep.resumen.total, 25000);
  assert.equal(rep.resumen.piezas, 1);
  assert.equal(rep.cancelaciones.n, 1);
  assert.equal(rep.cancelaciones.detalle[0].piezas, '1 × Ventilador');
});

test('reenviar la misma cancelacion no devuelve dos veces, y no se cancela mas de lo vendido', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const linea = (await detalle(pedir, id)).lineas[0].id;
  const antes = stock(db);

  const mismo = crypto.randomUUID();
  assert.equal((await cancelarPieza(pedir, id, linea, { id: mismo })).status, 201);
  const otra = await cancelarPieza(pedir, id, linea, { id: mismo });
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(stock(db), antes + 1);

  assert.equal((await cancelarPieza(pedir, id, linea, { cantidad: 2 })).status, 400);
  assert.equal((await cancelarPieza(pedir, id, linea)).status, 201);
  assert.equal((await cancelarPieza(pedir, id, linea)).status, 409);
  assert.equal(stock(db), antes + 2);
  assert.equal((await cancelarPieza(pedir, id, linea, { motivo: '' })).status, 400);
});

test('cancelar el ticket completo despues de una pieza devuelve solo lo que quedaba', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const antes = stock(db);
  await cancelarPieza(pedir, id, (await detalle(pedir, id)).lineas[0].id);

  const r = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'se arrepintio', caja: 'Caja 1' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(db), antes + 2);

  // Y ya no se pueden cancelar piezas de un ticket cancelado.
  assert.equal((await cancelarPieza(pedir, id, (await detalle(pedir, id)).lineas[0].id)).status, 409);

  const c = (await cortar(pedir, 50000)).cuerpo;    // 500 + 500 - 250 - 250
  assert.equal(c.efectivo_devoluciones, 50000);
  assert.equal(c.diferencia, 0);

  const rep = (await pedir('/api/reportes')).cuerpo;
  assert.equal(rep.cancelaciones.total, 50000);     // 250 de la pieza + 250 del resto
});

test('con Dolarones: primero sale el dinero; lo pagado con D regresa al saldo y lo ganado se recalcula', async () => {
  const { db, pedir } = tienda();
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true,
  })).cuerpo;
  const saldoInicial = (await pedir('/api/socios?q=4449990000')).cuerpo.disponible;

  // $500: 100 D + $400 en efectivo. Gana 40 D.
  const id = await vender(pedir, { cliente_id: socio.id, dolarones: 10000, pin: '1234', efectivo: 40000 });
  const ganado = () => (db.prepare('select restante from dolarones_lotes where venta_id = ?').get(id) as { restante: number }).restante;
  assert.equal(ganado(), 4000);
  const linea = (await detalle(pedir, id)).lineas[0].id;

  const primera = (await cancelarPieza(pedir, id, linea)).cuerpo;
  assert.equal(primera.devuelto, 25000);
  assert.equal(primera.dolarones, 0);
  assert.equal(ganado(), 1000);                     // quedan $150 pagados: 10 D

  const segunda = (await cancelarPieza(pedir, id, linea)).cuerpo;
  assert.equal(segunda.devuelto, 15000);
  assert.equal(segunda.dolarones, 10000);
  assert.equal(ganado(), 0);
  assert.equal((await pedir('/api/socios?q=4449990000')).cuerpo.disponible, saldoInicial);

  const c = (await cortar(pedir, 50000)).cuerpo;    // 500 + 400 - 250 - 150
  assert.equal(c.efectivo_devoluciones, 40000);
  assert.equal(c.dolarones, 0);                     // 100 D cobrados y 100 D devueltos
  assert.equal(c.diferencia, 0);
});

test('el candado de revision rechaza una cancelacion que leyo un ticket ya cambiado', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  db.prepare('update ventas set revision = 1 where id = ?').run(id);
  assert.throws(() => db.prepare('update ventas set revision = 1 where id = ?').run(id), /ticket cambio/);
  assert.throws(() => db.prepare('update venta_lineas set cancelada_cantidad = 3 where venta_id = ?').run(id),
    /pieza ya cancelada/);
});

test('el comprobante de devolucion sale con piezas, lo devuelto, el motivo y las firmas', async () => {
  const pedazos: Uint8Array[] = [];
  const dev = {
    opened: false, configuration: { configurationValue: 1 },
    configurations: [{ interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [{ direction: 'out', endpointNumber: 1 }] }] }] }],
    async open() { dev.opened = true; }, async close() { dev.opened = false; },
    async selectConfiguration() {}, async claimInterface() {}, async clearHalt() {},
    async transferOut(_e: number, datos: Uint8Array) { pedazos.push(datos.slice()); return { status: 'ok' }; },
  };
  Object.defineProperty(globalThis.navigator, 'usb', { value: { getDevices: async () => [dev] }, configurable: true });
  const { reconectarImpresora, imprimirDevolucion } = await import('../public/impresora.js');
  const { comprobanteDevolucion, comprobanteCancelacion } = await import('../public/ticket.js');
  await reconectarImpresora();

  // Lo que regresa GET /api/ventas/:id tras cancelar 1 de 2 ventiladores de un ticket de $500 con 100 D.
  const ticket = {
    creado_en: '2026-10-02T17:00:00Z', forma_pago: 'efectivo', total: 50000, dolarones: 10000,
    devuelto: 25000, dolarones_devueltos: 0, cancelada_caja: 'Caja 2', cancelada_por: 'caja2@prueba.mx',
    cancelada_en: '2026-10-02T19:00:00Z', motivo_cancelacion: 'Se arrepintio',
    lineas: [{ nombre: 'Ventilador', precio: 25000, cantidad: 2, cancelada_cantidad: 1 }],
    devoluciones: [{ id: 'x', nombre: 'Ventilador', cantidad: 1, importe: 25000, dolarones: 0, caja: 'Caja 1',
      autor: 'caja@prueba.mx', motivo: 'Venia con una aspa rota', creado_en: '2026-10-02T18:00:00Z' }],
  };
  assert.equal(await imprimirDevolucion(comprobanteDevolucion(ticket, 0)), true);
  let texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /DEVOLUCION DE PIEZAS[\s\S]*Caja: Caja 1[\s\S]*Ventilador\n +1 pieza +\$250\.00/);
  assert.match(texto, /DEVUELTO EN EFECTIVO +\$250\.00[\s\S]*Motivo:\nVenia con una aspa rota/);
  assert.match(texto, /Entrega: _+\n +caja@prueba\.mx[\s\S]*Recibe: +_+/);

  // Cancelar el resto: solo la pieza que quedaba, $150 en dinero y 100 D al saldo.
  pedazos.length = 0;
  assert.equal(await imprimirDevolucion(comprobanteCancelacion(ticket)), true);
  texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /CANCELACION DE TICKET[\s\S]*Caja: Caja 2/);
  assert.match(texto, /DEVUELTO EN EFECTIVO +\$150\.00\n[\s\S]*Regresado al saldo \(Dolarones\) +100 D/);
});
