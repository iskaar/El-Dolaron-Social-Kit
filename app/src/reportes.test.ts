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

/** Una pieza individual en piso, capturada hace `dias` dias (misma hora, asi el dia de la tienda cuadra exacto). */
const pieza = (db: ReturnType<typeof tienda>['db'], codigo: string, extra: Record<string, unknown> = {}) => {
  const f = { categoria: 'ropa', precio: 10000, stock: 1, destino: 'etiqueta', sin_inventario: 0, estado_fisico: 'nuevo', dias: 0, creado_en: null, ...extra };
  const creado = f.creado_en ?? new Date(Date.now() - Number(f.dias) * 86_400_000).toISOString();
  db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, destino, sin_inventario, estado_fisico, semana_ingreso, creado_en, actualizado_en)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'S40', ?, ?)`)
    .run(crypto.randomUUID(), codigo, `Pieza ${codigo}`, f.categoria, f.precio, f.stock, f.destino, f.sin_inventario, f.estado_fisico, creado, creado);
};

test('inventario en piso: solo piezas individuales con etiqueta y existencia, al centavo y por tramos de semanas completas', async () => {
  const { db, pedir } = tienda();
  db.prepare('delete from productos where id = ?').run(PRODUCTO);   // la pieza de la tienda de prueba no trae fecha: aqui no estorba
  // Los limites de cada tramo: 20 dias = 2 semanas completas ('0-2'), 21 = 3 ('3-4'), 35 = 5, 63 = 9.
  const tramos = [[0, '0-2'], [14, '0-2'], [20, '0-2'], [21, '3-4'], [34, '3-4'], [35, '5-8'], [62, '5-8'], [63, '9+'], [200, '9+']] as const;
  tramos.forEach(([dias], i) => pieza(db, `T${i}`, { dias, precio: 10000 + i, stock: 2, categoria: i % 2 ? 'hogar' : 'ropa' }));
  pieza(db, 'DANADA', { dias: 30, precio: 5000, stock: 1, estado_fisico: 'danado', categoria: '' });   // danada: esta en piso, cuenta
  // Fuera: agotada, sin etiqueta (aun en la cola de revision), una banda a mano y las bandas de las migraciones.
  pieza(db, 'AGOTADA', { dias: 10, stock: 0 });
  db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, 'Sin etiqueta', 9900, 1, 'S40', ?, ?)`)
    .run(crypto.randomUUID(), new Date().toISOString(), new Date().toISOString());
  pieza(db, 'BANDA-X', { dias: 40, sin_inventario: 1, destino: 'banda_ju49' });

  const { cuerpo } = await pedir('/api/reportes?dias=30');
  const inv = cuerpo.inventario;
  assert.equal(inv.piezas, 10);                                   // 9 + la danada
  assert.equal(inv.unidades, 9 * 2 + 1);
  const valorTramos = tramos.reduce((s, _, i) => s + (10000 + i) * 2, 0);
  assert.equal(inv.valor, valorTramos + 5000);                    // centavos enteros: precio x existencia
  const por = Object.fromEntries(inv.por_antiguedad.map((t: { tramo: string; piezas: number; valor: number }) => [t.tramo, t]));
  assert.deepEqual(inv.por_antiguedad.map((t: { tramo: string }) => t.tramo), ['0-2', '3-4', '5-8', '9+']);
  assert.deepEqual(['0-2', '3-4', '5-8', '9+'].map((t) => por[t].piezas), [3, 3, 2, 2]);   // la danada (30 dias) cae en '3-4'
  assert.equal(por['9+'].valor, (10000 + 7) * 2 + (10000 + 8) * 2);
  assert.deepEqual(inv.sin_fecha, { piezas: 0, valor: 0 });
  assert.equal(inv.por_antiguedad.reduce((s: number, t: { piezas: number }) => s + t.piezas, 0) + inv.sin_fecha.piezas, inv.piezas);

  // Por categoria: la danada sin categoria no se pierde y el orden es por valor.
  const cat = Object.fromEntries(inv.por_categoria.map((c: { categoria: string }) => [c.categoria, c]));
  assert.deepEqual(Object.keys(cat).sort(), ['hogar', 'ropa', 'sin categoria']);
  assert.equal(cat['sin categoria'].piezas, 1);
  assert.equal(cat['sin categoria'].dias_promedio, 30);
  assert.equal(inv.por_categoria.reduce((s: number, c: { valor: number }) => s + c.valor, 0), inv.valor);
  assert.ok(inv.por_categoria[0].valor >= inv.por_categoria[1].valor);

  // Las mas viejas: de mayor a menor antiguedad, con su edad en dias.
  assert.equal(inv.mas_viejas[0].codigo, 'T8');
  assert.equal(inv.mas_viejas[0].dias, 200);
  const edades = inv.mas_viejas.map((p: { dias: number }) => p.dias);
  assert.deepEqual(edades, [...edades].sort((a: number, b: number) => b - a));
  assert.ok(!inv.mas_viejas.some((p: { codigo: string }) => ['AGOTADA', 'BANDA-X'].includes(p.codigo)));

  // Es una foto de ahora: no cambia con el periodo ni toca el cuadre de ventas.
  assert.deepEqual((await pedir('/api/reportes?dias=7')).cuerpo.inventario, inv);
  assert.deepEqual((await pedir('/api/reportes?dias=365')).cuerpo.inventario, inv);
  assert.deepEqual(verificarCuadre(cuerpo).filter((c: { ok: boolean }) => !c.ok), []);
});

test('inventario en piso: una fecha vacia o invalida va aparte, sin adivinar, y no entra a promedios ni a las mas viejas', async () => {
  const { db, pedir } = tienda();   // la pieza de la tienda de prueba tiene creado_en vacio: 50 x $250
  pieza(db, 'RARA', { creado_en: 'no-es-fecha', precio: 3000, stock: 2 });
  pieza(db, 'FECHADA', { dias: 10, precio: 1000, stock: 1 });
  const inv = (await pedir('/api/reportes?dias=30')).cuerpo.inventario;
  assert.equal(inv.piezas, 3);
  assert.deepEqual(inv.sin_fecha, { piezas: 2, valor: 50 * 25000 + 2 * 3000 });
  assert.equal(inv.por_antiguedad.reduce((s: number, t: { piezas: number }) => s + t.piezas, 0), 1);
  assert.deepEqual(inv.mas_viejas.map((p: { codigo: string }) => p.codigo), ['FECHADA']);
  const ropa = inv.por_categoria.find((c: { categoria: string }) => c.categoria === 'ropa');
  assert.equal(ropa.piezas, 2);
  assert.equal(ropa.dias_promedio, 10);   // solo la fechada promedia
  assert.equal(inv.valor, 50 * 25000 + 2 * 3000 + 1000);
  // Todo sin fecha: no hay promedio que inventar.
  db.prepare(`update productos set creado_en = ''`).run();
  assert.equal((await pedir('/api/reportes')).cuerpo.inventario.por_categoria[0].dias_promedio, null);
});

test('las mas viejas son quince, las de mas dias primero', async () => {
  const { db, pedir } = tienda();
  db.prepare('delete from productos where id = ?').run(PRODUCTO);
  for (let i = 0; i < 20; i++) pieza(db, `P${String(i).padStart(2, '0')}`, { dias: i * 3 });
  const { mas_viejas: viejas, piezas } = (await pedir('/api/reportes')).cuerpo.inventario;
  assert.equal(piezas, 20);
  assert.equal(viejas.length, 15);
  assert.equal(viejas[0].codigo, 'P19');
  assert.equal(viejas[0].dias, 57);
  assert.equal(viejas[14].dias, 15);
});

test('por_categoria_anterior: lo vendido por categoria en el periodo de igual largo justo antes, con las mismas reglas', async () => {
  const { db, pedir } = tienda();
  const otra = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, semana_ingreso, creado_en, actualizado_en)
              values (?, 'ED-000002', 'Mesa', 'hogar', 40000, 50, 'S40', '', '')`).run(otra);
  db.prepare(`update productos set categoria = 'ropa', stock = 100 where id = ?`).run(PRODUCTO);
  const vender2 = (producto: string, cantidad = 1) => vender(pedir, 'Caja 1', { lineas: [{ producto_id: producto, cantidad }], efectivo: 500000 });
  const antes = [await vender2(PRODUCTO, 2), await vender2(otra), await vender2(PRODUCTO), await vender2(otra)];   // ropa 2 + 1, hogar 1 + 1
  const ahora = [await vender2(PRODUCTO), await vender2(PRODUCTO)];                                              // solo ropa: hogar no vendio
  assert.ok([...antes, ...ahora].every((v) => v.status === 201));
  assert.equal((await pedir(`/api/ventas/${antes[3].id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);   // la cancelada no cuenta
  // Las 4 de antes pasan a 8 dias atras (periodo anterior de uno de 7 dias); la de hace 20 dias queda fuera de los dos.
  const hace8 = new Date(Date.now() - 8 * 86_400_000).toISOString();
  for (const v of antes) db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace8, hace8, v.id);
  const lejana = await vender2(PRODUCTO);
  const hace20 = new Date(Date.now() - 20 * 86_400_000).toISOString();
  db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace20, hace20, lejana.id);

  const r = (await pedir('/api/reportes?dias=7')).cuerpo;
  assert.deepEqual(r.por_categoria, [{ categoria: 'ropa', total: 50000, piezas: 2 }]);
  assert.deepEqual(r.por_categoria_anterior, [
    { categoria: 'ropa', total: 75000, piezas: 3 },
    { categoria: 'hogar', total: 40000, piezas: 1 },   // la mesa cancelada no cuenta
  ]);
  assert.equal(r.por_categoria_anterior.reduce((s: number, c: { total: number }) => s + c.total, 0), r.anterior.total);
  assert.deepEqual(verificarCuadre(r).filter((c: { ok: boolean }) => !c.ok), []);
  // Sin categoria guardada ('' es lo que deja una captura sin clasificar): una sola cubeta, la misma de ahora y de antes.
  db.prepare(`update productos set categoria = ''`).run();
  const sin = (await pedir('/api/reportes?dias=7')).cuerpo;
  assert.deepEqual(sin.por_categoria.map((c: { categoria: string }) => c.categoria), ['sin categoria']);
  assert.deepEqual(sin.por_categoria_anterior.map((c: { categoria: string }) => c.categoria), ['sin categoria']);
});
