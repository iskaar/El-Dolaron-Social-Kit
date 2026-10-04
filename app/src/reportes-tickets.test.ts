// node --test src/reportes-tickets.test.ts
// Tickets del rango en /reportes (Issue #164): filtros, totales y paginacion contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

type Pedir = ReturnType<typeof tienda>['pedir'];

// Venta de $250 (el producto de prueba) en la caja que se diga.
const vender = (pedir: Pedir, caja: string, extra: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID();
  return pedir('/api/ventas', {
    id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja, ...extra,
  }).then((r) => ({ ...r, id }));
};
const tickets = (pedir: Pedir, consulta = '') => pedir(`/api/reportes/tickets?dias=7${consulta}`);

test('lista los tickets del rango con su resumen y filtra por forma de pago, caja y estado', async () => {
  const { pedir } = tienda();
  await vender(pedir, 'Caja 1');
  await vender(pedir, 'Caja 1', { forma_pago: 'tarjeta', efectivo: 0 });
  const cancelada = await vender(pedir, 'Caja 2');
  assert.equal((await pedir(`/api/ventas/${cancelada.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 2' })).status, 200);

  const todos = (await tickets(pedir)).cuerpo;
  assert.equal(todos.tickets.length, 3);
  assert.equal(todos.resumen.tickets, 3);
  assert.equal(todos.resumen.vendido, 50000);         // la cancelada no vale
  assert.equal(todos.resumen.cancelados, 1);
  assert.equal(todos.resumen.piezas, 2);
  assert.deepEqual(todos.cajas, ['Caja 1', 'Caja 2']);
  assert.equal(todos.hay_mas, false);

  assert.equal((await tickets(pedir, '&forma_pago=tarjeta')).cuerpo.tickets.length, 1);
  assert.equal((await tickets(pedir, '&caja=Caja%201')).cuerpo.resumen.tickets, 2);
  const canceladas = (await tickets(pedir, '&estado=cancelado')).cuerpo;
  assert.deepEqual(canceladas.tickets.map((t: { id: string }) => t.id), [cancelada.id]);
  assert.equal(canceladas.resumen.vendido, 0);
  assert.equal((await tickets(pedir, '&estado=vigente')).cuerpo.resumen.tickets, 2);
});

test('una pieza devuelta baja lo vendido y el ticket sale en «con devoluciones»', async () => {
  const { pedir } = tienda();
  const venta = await vender(pedir, 'Caja 1', { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  assert.equal(venta.status, 201);
  const linea = (await pedir(`/api/ventas/${venta.id}`)).cuerpo.lineas[0].id;
  assert.equal((await pedir(`/api/ventas/${venta.id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);

  const r = (await tickets(pedir, '&estado=devolucion')).cuerpo;
  assert.equal(r.resumen.tickets, 1);
  assert.equal(r.resumen.vendido, 25000);
  assert.equal(r.resumen.piezas, 1);
  assert.equal(r.tickets[0].cancelada_cantidad, 1);
  assert.equal((await tickets(pedir, '&estado=cancelado')).cuerpo.resumen.tickets, 0);
});

test('pagina de 50 en 50 y avisa si hay mas', async () => {
  const { db, pedir } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  for (let i = 0; i < 51; i++) assert.equal((await vender(pedir, 'Caja 1')).status, 201);
  const primera = (await tickets(pedir)).cuerpo;
  assert.equal(primera.tickets.length, 50);
  assert.equal(primera.hay_mas, true);
  assert.equal(primera.resumen.tickets, 51);
  const segunda = (await tickets(pedir, '&pagina=1')).cuerpo;
  assert.equal(segunda.tickets.length, 1);
  assert.equal(segunda.hay_mas, false);
  assert.ok(!primera.tickets.some((t: { id: string }) => t.id === segunda.tickets[0].id));
});

test('solo el dueno ve los tickets del rango', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('caja@prueba.mx', 'K', 'cajero', 1, '', ''), ('captura@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  for (const correo of ['caja@prueba.mx', 'captura@prueba.mx']) {
    (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo;
    assert.equal((await tickets(pedir)).status, 403, correo);
  }
});
