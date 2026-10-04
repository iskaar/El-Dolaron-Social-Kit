// node --test src/reportes.test.ts
// /api/reportes al centavo (Issue #166): todo suma lo mismo, por dias completos de la tienda.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';
import { verificarCuadre, rellenarDias } from '../public/graficas.js';

type Pedir = ReturnType<typeof tienda>['pedir'];

const vender = (pedir: Pedir, caja: string, extra: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID();
  return pedir('/api/ventas', {
    id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja, ...extra,
  }).then((r) => ({ ...r, id }));
};

test('con ventas de todo tipo, el reporte cuadra al centavo y bruto - devoluciones - cancelados = vendido', async () => {
  const { db, pedir } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true, declara_mayor_edad: true,
  })).cuerpo;
  assert.equal((await pedir('/api/portal/llegada', { cliente_id: socio.id })).status, 200);

  await vender(pedir, 'Caja 1');                                                    // efectivo $250
  await vender(pedir, 'Caja 1', { forma_pago: 'tarjeta', efectivo: 0 });            // tarjeta $250
  await vender(pedir, 'Caja 2', { forma_pago: 'transferencia', efectivo: 0 });      // transferencia $250
  assert.equal((await vender(pedir, 'Caja 1', {                                     // $1,000 con 50 D de apertura
    cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(db, socio.id), efectivo: 95000,
    lineas: [{ producto_id: PRODUCTO, cantidad: 4 }],
  })).status, 201);
  const cancelada = await vender(pedir, 'Caja 2');                                  // cancelada completa
  assert.equal((await pedir(`/api/ventas/${cancelada.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 2' })).status, 200);
  const doble = await vender(pedir, 'Caja 1', { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  const linea = (await pedir(`/api/ventas/${doble.id}`)).cuerpo.lineas[0].id;      // devuelve 1 de 2
  assert.equal((await pedir(`/api/ventas/${doble.id}/lineas/${linea}/cancelar`,
    { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);

  const r = (await pedir('/api/reportes?dias=7')).cuerpo;
  const fallas = verificarCuadre(r).filter((c: { ok: boolean }) => !c.ok);
  assert.deepEqual(fallas, [], JSON.stringify(fallas));

  // 250 x 3 + 1,000 + 250 (la que queda de las 2) = 2,000; bruto = 250 x 4 + 1,000 + 500 = 2,500
  assert.equal(r.resumen.total, 200000);
  assert.equal(r.cuadre.bruto, 250000);
  assert.equal(r.cuadre.devoluciones_pieza, 25000);
  assert.equal(r.cuadre.cancelados, 25000);
  assert.equal(r.cuadre.vendido, 200000);
  assert.equal(r.resumen.ventas, 5);
  assert.equal(r.resumen.ticket_promedio, 40000);
  assert.equal(r.por_forma_pago.find((f: { forma_pago: string }) => f.forma_pago === 'dolarones').total, 5000);
  assert.equal(r.cancelaciones.n, 2);                          // el ticket completo y la pieza
  assert.equal(r.cancelaciones.total, 50000);                  // $250 + $250 devueltos en dinero
  assert.equal(r.cancelaciones.dolarones, 0);
  assert.deepEqual(r.cancelaciones.detalle.map((d: { tipo: string }) => d.tipo).sort(), ['pieza', 'ticket']);

  // Un solo dia de la tienda, con el rango completo y sin periodo anterior.
  assert.equal(r.dia_desde <= r.dia_hasta, true);
  assert.equal(rellenarDias(r.por_dia, r.dia_desde, r.dia_hasta).length, 7);
  assert.equal(r.anterior.total, 0);

  // Mapa de calor: lo mismo vendido, por dia de la semana y hora, sin la cancelada.
  assert.equal(r.por_hora.reduce((s: number, f: { total: number }) => s + f.total, 0), 200000);
  assert.equal(r.por_hora.reduce((s: number, f: { tickets: number }) => s + f.tickets, 0), 5);
});

test('por_hora usa el dia de la semana y la hora de la tienda (UTC-6) y no cuenta cancelados', async () => {
  const { db, pedir } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const ids = [(await vender(pedir, 'Caja 1')).id, (await vender(pedir, 'Caja 1')).id, (await vender(pedir, 'Caja 1')).id];
  assert.equal((await pedir(`/api/ventas/${ids[1]}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  // Hace 3 dias a las 03:30 UTC es la noche anterior en la tienda (21:30, UTC-6): otro dia de la semana.
  const base = new Date(Date.now() - 3 * 86_400_000);
  base.setUTCHours(3, 30, 0, 0);
  const noche = base.toISOString();
  const manana = new Date(base.getTime() + 8 * 3_600_000).toISOString();   // 11:30 UTC = 05:30 en la tienda
  for (const [id, cuando] of [[ids[0], noche], [ids[1], noche], [ids[2], manana]]) {
    db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  }

  const { por_hora: horas, resumen } = (await pedir('/api/reportes?dias=7')).cuerpo;
  const diaNoche = new Date(base.getTime() - 6 * 3_600_000).getUTCDay();
  assert.deepEqual(horas.find((f: { hora: number }) => f.hora === 21), { dia_semana: diaNoche, hora: 21, tickets: 1, total: 25000 });   // la cancelada no cuenta
  assert.equal(horas.find((f: { hora: number }) => f.hora === 5).dia_semana, (diaNoche + 1) % 7);
  assert.equal(horas.reduce((s: number, f: { total: number }) => s + f.total, 0), resumen.total);
});

test('el periodo anterior suma lo de los dias justo antes, sin traslape', async () => {
  const { db, pedir } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const vieja = await vender(pedir, 'Caja 1');
  const hoy = await vender(pedir, 'Caja 1');
  assert.equal(vieja.status, 201); assert.equal(hoy.status, 201);
  // La vieja pasa a ocho dias atras: cae en el periodo anterior de uno de 7 dias.
  const hace8 = new Date(Date.now() - 8 * 86_400_000).toISOString();
  db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace8, hace8, vieja.id);

  const r = (await pedir('/api/reportes?dias=7')).cuerpo;
  assert.equal(r.resumen.total, 25000);
  assert.equal(r.anterior.total, 25000);
  assert.equal(r.anterior.ventas, 1);
  assert.equal(r.anterior.piezas, 1);
  assert.equal((await pedir('/api/reportes/tickets?dias=7')).cuerpo.resumen.tickets, 1);   // la lista usa el mismo rango
});

test('los tickets se filtran por un dia de la tienda', async () => {
  const { db, pedir } = tienda();
  db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const ayer = await vender(pedir, 'Caja 1');
  await vender(pedir, 'Caja 1');
  const hace24 = new Date(Date.now() - 86_400_000).toISOString();
  db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace24, hace24, ayer.id);
  const dia = new Date(Date.parse(hace24) - 6 * 3_600_000).toISOString().slice(0, 10);

  const solo = (await pedir(`/api/reportes/tickets?dias=7&dia=${dia}`)).cuerpo;
  assert.deepEqual(solo.tickets.map((t: { id: string }) => t.id), [ayer.id]);
  assert.equal((await pedir('/api/reportes/tickets?dias=7&dia=no-es-fecha')).cuerpo.resumen.tickets, 2);
});
