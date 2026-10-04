// node --test src/reportes-tickets.test.ts
// Tickets del rango en /reportes (Issue #164): filtros, totales y paginacion contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, DUENO, PRODUCTO } from './prueba-d1.ts';

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

// Una fila de CSV por ticket, sin el encabezado, como lista de celdas (las pruebas no llevan comas ni comillas).
const filasCsv = (texto: string) => texto.replace(/^﻿/, '').split('\r\n').map((f) => f.split(','));

test('exporta los tickets a CSV: encabezado, centavos, hora de la tienda y los mismos filtros que la lista', async () => {
  const { db, pedir, pedirTexto } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const efectivo = await vender(pedir, 'Caja 1');
  await vender(pedir, 'Caja 2', { forma_pago: 'tarjeta', efectivo: 0 });
  const doble = await vender(pedir, 'Caja 1', { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  const linea = (await pedir(`/api/ventas/${doble.id}`)).cuerpo.lineas[0].id;
  assert.equal((await pedir(`/api/ventas/${doble.id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  const cancelada = await vender(pedir, 'Caja 2');
  assert.equal((await pedir(`/api/ventas/${cancelada.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 2' })).status, 200);
  // 03:05 UTC = 21:05 de la noche anterior en la tienda.
  const fecha = new Date(Date.now() - 86_400_000);
  fecha.setUTCHours(3, 5, 0, 0);
  db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(fecha.toISOString(), fecha.toISOString(), efectivo.id);
  const tienda21 = new Date(fecha.getTime() - 6 * 3_600_000).toISOString().slice(0, 10);

  const todos = await pedirTexto('/api/reportes/tickets.csv?dias=7');
  assert.equal(todos.status, 200);
  assert.match(todos.tipo, /^text\/csv/);
  assert.ok(todos.texto.startsWith('﻿'), 'BOM para Excel');
  const filas = filasCsv(todos.texto);
  assert.deepEqual(filas[0], ['fecha', 'ticket', 'caja', 'cajero', 'forma_pago', 'estado', 'piezas', 'cantidad', 'total', 'devuelto',
    'dolarones', 'dolarones_devueltos', 'vendido', 'socio']);
  assert.equal(filas.length, 5);   // encabezado + 4 tickets, todos: no se pagina
  const por = (id: string) => filas.find((f) => f[1] === id)!;
  assert.equal(por(efectivo.id)[0], `${tienda21} 21:05`);
  assert.deepEqual(por(efectivo.id).slice(2), [
    'Caja 1', DUENO, 'efectivo', 'vigente', 'Ventilador', '1', '250.00', '0.00', '0.00', '0.00', '250.00', 'no']);
  // Devolvio 1 de 2: el ticket vale lo que queda.
  assert.deepEqual(por(doble.id).slice(5), ['con devoluciones', 'Ventilador', '2', '500.00', '250.00', '0.00', '0.00', '250.00', 'no']);
  // Un cancelado ya no vale nada, aunque conserve su total.
  assert.deepEqual(por(cancelada.id).slice(5, 13), ['cancelado', 'Ventilador', '1', '250.00', '0.00', '0.00', '0.00', '0.00']);

  // Los filtros son los de la lista: mismos tickets en una y en otra.
  for (const consulta of ['&forma_pago=tarjeta', '&caja=Caja%201', '&estado=cancelado', '&estado=devolucion', `&dia=${tienda21}`]) {
    const lista = (await tickets(pedir, consulta)).cuerpo.tickets.map((t: { id: string }) => t.id).sort();
    const csv = filasCsv((await pedirTexto(`/api/reportes/tickets.csv?dias=7${consulta}`)).texto).slice(1).map((f) => f[1]).sort();
    assert.deepEqual(csv, lista, consulta);
    assert.ok(csv.length > 0 && csv.length < 4, consulta);
  }
});

test('el CSV de tickets lleva el socio y los Dolarones', async () => {
  const { db, pedir, pedirTexto } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true, declara_mayor_edad: true,
  })).cuerpo;
  assert.equal((await pedir('/api/portal/llegada', { cliente_id: socio.id })).status, 200);
  await vender(pedir, 'Caja 1');
  assert.equal((await vender(pedir, 'Caja 1', {
    cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(db, socio.id), efectivo: 95000,
    lineas: [{ producto_id: PRODUCTO, cantidad: 4 }],
  })).status, 201);

  const solo = filasCsv((await pedirTexto('/api/reportes/tickets.csv?dias=7&socio=1&dolarones=1')).texto);
  assert.equal(solo.length, 2);
  assert.deepEqual([solo[1][10], solo[1][12], solo[1][13]], ['50.00', '1000.00', 'sí']);
});

test('solo el dueno exporta los tickets', async () => {
  const { db, env, pedirTexto } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('caja@prueba.mx', 'K', 'cajero', 1, '', ''), ('captura@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  for (const correo of ['caja@prueba.mx', 'captura@prueba.mx']) {
    (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo;
    const r = await pedirTexto('/api/reportes/tickets.csv?dias=7');
    assert.equal(r.status, 403, correo);
    assert.ok(!r.texto.includes('fecha,ticket'), 'no filtra ni el encabezado');
  }
});
