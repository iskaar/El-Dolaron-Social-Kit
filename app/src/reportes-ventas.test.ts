// node --test src/reportes-ventas.test.ts
// Vista Ventas de /reportes (Issue #802): el endpoint contra el doble de D1, cuadrado con Resumen y con /api/reportes, y las funciones puras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda, consultaFormaPago } from './reportes.ts';
import { consultaTickets } from './reportes-ventas.ts';
import { permiso } from './cuentas.ts';
import { sumarDias } from '../public/graficas.js';
import { tarjetasHtml } from '../public/reportes-resumen.js';
import {
  armarVentas, milesimos, tarjetasVentas, graficas, notaCanales, notaCategorias, textoTickets, tablaTickets, tablaPago, tablaDescuentos,
  tablaCategorias, tablaCanales, LIMITES_MONTO, UMBRAL_DOLARONES, MAX_CATEGORIAS, MAX_COLUMNAS, sqlTramoMonto, datosCategorias,
} from '../public/reportes-ventas.js';

type T = ReturnType<typeof tienda>;
const CATEGORIAS = ['ropa', 'hogar', 'juguetes', 'calzado', 'electronica', 'deportes', 'herramientas', 'belleza'];

/** Ocho categorias (para que haya «Otras»), una banda y la pieza de la tienda de prueba (sin categoria). Devuelve los ids. */
function productos(t: T) {
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  const ids: string[] = [];
  CATEGORIAS.forEach((categoria, i) => {
    const id = crypto.randomUUID();
    t.db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, semana_ingreso, creado_en, actualizado_en)
      values (?, ?, ?, ?, ?, 100000, 'S40', '', '')`).run(id, `ED-0001${i}0`, `Pieza ${categoria}`, categoria, 4000 + i * 3500);
    ids.push(id);
  });
  const banda = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, sin_inventario, semana_ingreso, creado_en, actualizado_en)
    values (?, 'BANDA-120', 'Ropa por banda', 'ropa', 12000, 0, 1, 'S40', '', '')`).run(banda);
  return { ids, banda };
}

let consecutivo = 0;
const vender = async (t: T, dia: string, lineas: { producto_id: string; cantidad: number }[], extra: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID();
  const importe = lineas.reduce((s, l) => s + (t.db.prepare('select precio from productos where id = ?').get(l.producto_id) as { precio: number }).precio * l.cantidad, 0);
  const r = await t.pedir('/api/ventas', { id, lineas, forma_pago: 'efectivo', efectivo: importe, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const hora = String(7 + (consecutivo++ % 10)).padStart(2, '0');                      // 01:00 a 10:00 de la tienda: siempre el mismo dia
  const cuando = `${dia}T${hora}:00:00.000Z`;
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  return id;
};
const llamar = (t: T, ruta: string, consulta: string) => t.pedir(`/api/reportes/${ruta}?${consulta}`, undefined, 'GET');
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const sumaSeries = (series: { valores: number[] }[], i: number) => suma(series.map((s) => s.valores[i]));

/** Un periodo con de todo: categorias, banda, tarjeta, transferencia, Dolarones, descuento, promo, WhatsApp, revendedora, un cancelado y una devolucion. */
async function sembrar(t: T) {
  const { ids, banda } = productos(t);
  const hoy = hoyTienda(), dia = (n: number) => sumarDias(hoy, -n);
  const uno = (id: string, cantidad = 1) => [{ producto_id: id, cantidad }];
  const v: Record<string, string> = {};
  for (let n = 1; n <= 9; n++) {          // 9 dias seguidos, una o dos ventas por dia, categorias rotando
    v[`a${n}`] = await vender(t, dia(n), uno(ids[n % ids.length], 1 + (n % 3)));
    if (n % 2) v[`b${n}`] = await vender(t, dia(n), uno(ids[(n + 3) % ids.length]), {});
  }
  v.banda = await vender(t, dia(2), uno(banda, 3));
  v.sin = await vender(t, dia(4), uno(PRODUCTO, 2));
  v.cancelada = await vender(t, dia(5), uno(ids[0]));
  assert.equal((await t.pedir(`/api/ventas/${v.cancelada}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  v.devuelta = await vender(t, dia(3), uno(ids[1], 2));
  const linea = (await t.pedir(`/api/ventas/${v.devuelta}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${v.devuelta}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  // Formas de pago, descuento y promo escritos directo: el calculo solo lee estas columnas.
  t.db.prepare("update ventas set forma_pago = 'tarjeta' where id in (?, ?)").run(v.a2, v.a6);
  t.db.prepare("update ventas set forma_pago = 'transferencia' where id = ?").run(v.a4);
  t.db.prepare('update ventas set dolarones = 2000 where id = ?').run(v.a7);
  t.db.prepare('update ventas set descuento = 3000, promo = 1000 where id = ?').run(v.a1);
  t.db.prepare('update ventas set descuento = 1500, promo = 0 where id = ?').run(v.a3);
  t.db.prepare('update ventas set descuento = 1000, promo = 1000 where id = ?').run(v.banda);
  // Un pedido por WhatsApp y otro de una revendedora.
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('rev@prueba.mx', 'R', 'revendedora', 1, '', '')").run();
  const pedido = (id: string, vendedora: string, venta: string, anticipo = 0) => {
    t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, caja, creado_en, actualizado_en)
      values (?, ?, 'x', '1', 'tienda', 0, ?, 'vendido', '', ?, 'efectivo', 0, '', ?, 'Caja 1', ?, '')`)
      .run(id, id === 'p1' ? 1 : 2, vendedora, anticipo, venta, `${dia(6)}T18:00:00.000Z`);
    t.db.prepare('update ventas set pedido_id = ? where id = ?').run(id, venta);
  };
  pedido('p1', 'nadie@prueba.mx', v.a8);
  pedido('p2', 'rev@prueba.mx', v.a9, 5000);        // con anticipo: entra el dia del apartado, hace 6 dias
  return { ...v, ids, banda };
}

test('Ventas cuadra al centavo con Resumen y con /api/reportes: categorias, canales, pago, descuentos y tickets', async () => {
  const t = tienda();
  await sembrar(t);
  for (const consulta of ['dias=10', 'dias=10&grano=semana', 'dias=10&grano=dia&comparar=ninguna', 'dias=10&comparar=mes']) {
    const viejo = (await t.pedir(`/api/reportes?dias=10`, undefined, 'GET')).cuerpo;
    const R = (await llamar(t, 'resumen', consulta)).cuerpo;
    const rr = await llamar(t, 'ventas', consulta);
    assert.equal(rr.status, 200, consulta);
    const V = rr.cuerpo;
    // Las mismas cubetas que Resumen, y las ventas de cada una.
    assert.equal(V.grano, R.grano);
    assert.deepEqual(V.cubetas.map((c: any) => [c.desde, c.hasta, c.dias, c.parcial]), R.cubetas.map((c: any) => [c.desde, c.hasta, c.dias, c.parcial]), consulta);
    V.cubetas.forEach((c: any, i: number) => {
      assert.equal(c.ventas, R.cubetas[i].ventas, `${consulta} cubeta ${i}`);
      assert.equal(sumaSeries(V.categorias, i), R.cubetas[i].ventas, `categorias ${consulta} ${i}`);
      assert.equal(sumaSeries(V.canales, i), R.cubetas[i].ventas, `canales ${consulta} ${i}`);
      assert.equal(R.cubetas[i].tickets > 0, c.dias_con_venta > 0, `dias con venta ${i}`);
    });
    assert.equal(suma(V.cubetas.map((c: any) => c.ventas)), R.totales.ventas);
    assert.equal(V.dias_con_venta.periodo, R.dias_con_ventas);
    assert.equal(suma(V.cubetas.map((c: any) => c.dias_con_venta)), V.dias_con_venta.periodo);

    // Categorias: el top y «Otras» (8 categorias + sin categoria = 9): el periodo suma lo vendido y coincide con /api/reportes.
    assert.equal(V.categorias.length, MAX_CATEGORIAS + 1);
    assert.equal(V.categorias.at(-1).categoria, 'otras');
    assert.equal(V.categorias.at(-1).otras, viejo.por_categoria.length - MAX_CATEGORIAS);
    assert.equal(suma(V.categorias.map((c: any) => c.total)), viejo.resumen.total);
    assert.deepEqual(V.categorias.slice(0, MAX_CATEGORIAS).map((c: any) => [c.categoria, c.total]), [...viejo.por_categoria].sort((a: any, b: any) => b.total - a.total || a.categoria.localeCompare(b.categoria)).slice(0, MAX_CATEGORIAS).map((c: any) => [c.categoria, c.total]));   // el viejo no desempata
    assert.ok(viejo.por_categoria.some((c: any) => c.categoria === 'bandas'), 'la banda va aparte de la ropa (group by por posicion)');
    assert.ok(R.categorias.some((c: any) => c.categoria === 'bandas'));
    // Canales: los de Resumen.
    for (const c of V.canales) assert.equal(c.total, R.canales[c.clave].ventas, c.clave);
    assert.ok(V.canales.find((c: any) => c.clave === 'whatsapp').total > 0);
    assert.ok(V.canales.find((c: any) => c.clave === 'revendedoras').total > 0);
    // Forma de pago: por metodo, lo mismo que el panel de /api/reportes (anticipos y Dolarones incluidos).
    const viejoPago = new Map<string, number>(viejo.por_forma_pago.map((f: any) => [f.forma_pago, f.total]));
    for (const p of V.pago) assert.equal(p.total, viejoPago.get(p.clave) ?? 0, p.clave);
    assert.equal(suma(V.pago.map((p: any) => p.total)), suma([...viejoPago.values()]));
    assert.equal(V.pago.find((p: any) => p.clave === 'otra').total, 0);
    assert.ok(V.pago.find((p: any) => p.clave === 'dolarones').total > 0);
    assert.ok(V.pago.find((p: any) => p.clave === 'transferencia').total > 0);
    // Descuentos: los totales de /api/reportes y de Resumen, y por cubeta.
    assert.equal(V.descuentos.promo, viejo.descuentos.promo);
    assert.equal(V.descuentos.otros, viejo.descuentos.otros);
    assert.equal(V.descuentos.promo_tickets, viejo.descuentos.promo_tickets);
    assert.equal(V.descuentos.otros_tickets, viejo.descuentos.otros_tickets);
    assert.equal(V.descuentos.promo + V.descuentos.otros, R.totales.descuento);
    V.cubetas.forEach((_: unknown, i: number) => assert.equal(V.descuentos.valores[i].promo + V.descuentos.valores[i].otros, R.cubetas[i].descuento, `descuento ${consulta} ${i}`));
    assert.equal(V.descuentos.promo, 2000);        // la promo de a1 y de la banda
    assert.equal(V.descuentos.otros, 2000 + 1500); // lo aprobado: a1 (3000 - 1000 de promo) y a3
    // Tickets: los tramos suman los tickets, las ventas netas y las piezas de Resumen.
    assert.equal(V.tickets.total, R.totales.tickets);
    assert.equal(suma(V.tickets.monto.map((x: any) => x.n)), R.totales.tickets);
    assert.equal(suma(V.tickets.piezas.map((x: any) => x.n)), R.totales.tickets);
    assert.equal(suma(V.tickets.monto.map((x: any) => x.total)), R.totales.ventas);
    assert.equal(suma(V.tickets.piezas.map((x: any) => x.total)), R.totales.ventas);
    assert.equal(V.tickets.total, viejo.resumen.ventas);
    assert.equal(V.tickets.bajo_umbral, V.tickets.monto[0].n);
    assert.equal(V.tickets.umbral, UMBRAL_DOLARONES);
  }
  t.db.close();
});

test('la mediana y los tramos de los tickets salen del importe neto de cada ticket', async () => {
  const t = tienda();
  const { ids } = productos(t);
  const hoy = hoyTienda();
  // Precios: ids[0] = $40, ids[1] = $75, ids[2] = $110, ids[3] = $145. Tickets (en pesos): 40, 75, 110, 110, 225 (3 x $75) y 550 (5 x $110).
  const venta = (id: string, n = 1) => vender(t, hoy, [{ producto_id: id, cantidad: n }]);
  await venta(ids[0]); await venta(ids[1]); await venta(ids[2]); await venta(ids[2]); await venta(ids[1], 3); await venta(ids[2], 5);
  const V = (await llamar(t, 'ventas', 'dias=1')).cuerpo;
  const R = (await llamar(t, 'resumen', 'dias=1')).cuerpo;
  assert.equal(V.tickets.total, R.totales.tickets);
  assert.equal(V.tickets.total, 6);
  assert.equal(V.tickets.mediana, 11000);                                          // par: el promedio de los dos del centro ($110 y $110)
  assert.deepEqual(V.tickets.monto.map((m: any) => m.n), [2, 2, 1, 0, 1, 0, 0]);     // menos de 100, 100-200, 200-300, 300-500, 500-800, 800-1,200, mas
  assert.equal(V.tickets.monto[0].total, 4000 + 7500);
  assert.equal(V.tickets.bajo_umbral, 2);
  assert.deepEqual(V.tickets.piezas.map((m: any) => m.n), [4, 0, 1, 0, 1, 0]);        // 1, 2, 3, 4, 5, 6 o mas piezas
  assert.equal(suma(V.tickets.monto.map((m: any) => m.total)), R.totales.ventas);
  assert.equal(LIMITES_MONTO[0], UMBRAL_DOLARONES);
  await venta(ids[3]);                                                               // impar: el del centro
  const impar = (await llamar(t, 'ventas', 'dias=1')).cuerpo;
  assert.equal(impar.tickets.total, 7);
  assert.equal(impar.tickets.mediana, 11000);                                      // 40, 75, 110, 110, 145, 225, 550
  t.db.close();
});

test('periodo vacio: todo en cero y ninguna serie inventada', async () => {
  const t = tienda();
  productos(t);
  const V = (await llamar(t, 'ventas', 'dias=28')).cuerpo;
  assert.equal(V.cubetas.length, 28);
  assert.deepEqual(V.categorias, []);
  assert.ok(V.canales.every((c: any) => c.total === 0 && c.valores.length === 28));
  assert.ok(V.pago.every((p: any) => p.total === 0));
  assert.equal(V.descuentos.promo + V.descuentos.otros, 0);
  assert.equal(V.tickets.total, 0);
  assert.equal(V.tickets.mediana, null);
  assert.deepEqual(V.tickets.monto.map((m: any) => m.n), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(V.dias_con_venta.periodo, 0);
  assert.equal(V.dias_con_venta.anterior, 0);
  assert.equal(V.cubetas.every((c: any) => c.dias_con_venta === 0 && c.ventas === 0), true);
  const sinComparar = (await llamar(t, 'ventas', 'dias=7&comparar=ninguna')).cuerpo;
  assert.equal(sinComparar.dias_con_venta.anterior, null);
  assert.equal(sinComparar.comparacion, null);
  // Y la pantalla lo dice en vez de dibujar ejes vacios.
  const R = (await llamar(t, 'resumen', 'dias=28')).cuerpo;
  const g = graficas(R, V, () => 600);
  for (const clave of ['categorias', 'canales', 'pago', 'descuentos', 'tickets_monto', 'tickets_piezas']) assert.match(g[clave], /class="vacio"/, clave);
  assert.doesNotMatch(Object.values(g).join(''), /<svg/);
  assert.equal(notaCanales(V), '');
  t.db.close();
});

test('un solo dia: una cubeta, con su comparacion', async () => {
  const t = tienda();
  const { ids } = productos(t);
  const hoy = hoyTienda();
  await vender(t, hoy, [{ producto_id: ids[0], cantidad: 2 }]);
  await vender(t, sumarDias(hoy, -1), [{ producto_id: ids[1], cantidad: 1 }]);
  const V = (await llamar(t, 'ventas', 'dias=1')).cuerpo;
  assert.equal(V.cubetas.length, 1);
  assert.equal(V.cubetas[0].dias_con_venta, 1);
  assert.equal(V.dias_con_venta.periodo, 1);
  assert.equal(V.dias_con_venta.anterior, 1);                  // ayer, la comparacion
  assert.equal(V.categorias.length, 1);
  assert.equal(V.categorias[0].valores[0], V.cubetas[0].ventas);
  assert.equal(V.canales.find((c: any) => c.clave === 'tienda').valores[0], V.cubetas[0].ventas);
  assert.equal(V.pago.find((p: any) => p.clave === 'efectivo').valores[0], V.cubetas[0].ventas);
  assert.equal(V.tickets.total, 1);
  assert.equal(V.tickets.mediana, V.cubetas[0].ventas);
  t.db.close();
});

test('un rango pasado y cerrado que cruza el mes: por semana, por mes y contra el mes pasado', async () => {
  const t = tienda();
  const { ids } = productos(t);
  const lineas = (i: number, n = 1) => [{ producto_id: ids[i], cantidad: n }];
  for (const [dia, i, n] of [['2026-01-29', 0, 1], ['2026-01-31', 1, 2], ['2026-02-02', 2, 1], ['2026-02-02', 3, 1], ['2026-02-03', 0, 3], ['2026-02-11', 4, 1], ['2025-12-30', 5, 1]] as const) {
    await vender(t, dia, lineas(i, n));
  }
  t.db.prepare("update ventas set descuento = 2000, promo = 500 where creado_en like '2026-02-02%'").run();
  for (const consulta of ['desde=2026-01-26&hasta=2026-02-15&grano=semana', 'desde=2026-01-15&hasta=2026-02-28&grano=mes&comparar=ninguna', 'desde=2026-01-30&hasta=2026-02-03&comparar=mes']) {
    const R = (await llamar(t, 'resumen', consulta)).cuerpo;
    const V = (await llamar(t, 'ventas', consulta)).cuerpo;
    assert.deepEqual(V.cubetas.map((c: any) => [c.desde, c.hasta, c.dias]), R.cubetas.map((c: any) => [c.desde, c.hasta, c.dias]), consulta);
    V.cubetas.forEach((c: any, i: number) => {
      assert.equal(c.ventas, R.cubetas[i].ventas, consulta);
      assert.equal(sumaSeries(V.categorias, i), c.ventas);
      assert.equal(sumaSeries(V.canales, i), c.ventas);
      assert.equal(V.descuentos.valores[i].promo + V.descuentos.valores[i].otros, R.cubetas[i].descuento);
    });
    assert.equal(V.tickets.total, R.totales.tickets);
    assert.equal(V.dias_con_venta.periodo, R.dias_con_ventas);
    assert.equal(suma(V.pago.map((p: any) => p.total)), R.totales.ventas);          // sin anticipos ni Dolarones, lo cobrado es lo vendido
  }
  // Semanas de lunes a domingo que cruzan el mes: el 2 de febrero (lunes) abre la semana; el 31 de enero cae en la anterior.
  const sem = (await llamar(t, 'ventas', 'desde=2026-01-26&hasta=2026-02-15&grano=semana')).cuerpo;
  assert.deepEqual(sem.cubetas.map((c: any) => c.desde), ['2026-01-26', '2026-02-02', '2026-02-09']);
  assert.deepEqual(sem.cubetas.map((c: any) => c.dias_con_venta), [2, 2, 1]);
  assert.equal(sem.descuentos.valores[1].promo, 1000);                                  // dos tickets del 2 de febrero
  assert.equal(sem.descuentos.valores[0].promo, 0);
  // La comparacion un mes atras cuenta sus dias con venta (30 dic).
  const mes = (await llamar(t, 'ventas', 'desde=2026-01-30&hasta=2026-02-03&comparar=mes')).cuerpo;
  assert.equal(mes.dias_con_venta.anterior, 1);
  t.db.close();
});

test('con tienda todo se acota a ventas.tienda, tambien lo cobrado por caja', async () => {
  const t = tienda();
  const { ids } = productos(t);
  const hoy = hoyTienda();
  const a = await vender(t, hoy, [{ producto_id: ids[0], cantidad: 1 }]);
  const b = await vender(t, hoy, [{ producto_id: ids[1], cantidad: 2 }]);
  t.db.prepare("update ventas set tienda = 'salk' where id = ?").run(b);
  t.db.prepare("update ventas set descuento = 1000, promo = 1000 where id in (?, ?)").run(a, b);
  const todo = (await llamar(t, 'ventas', 'dias=7')).cuerpo;
  const salk = (await llamar(t, 'ventas', 'dias=7&tienda=salk')).cuerpo;
  const R = (await llamar(t, 'resumen', 'dias=7&tienda=salk')).cuerpo;
  assert.equal(salk.tienda, 'salk');
  assert.equal(suma(salk.categorias.map((c: any) => c.total)), R.totales.ventas);
  assert.equal(salk.categorias.length, 1);
  assert.equal(salk.categorias[0].categoria, 'hogar');
  assert.equal(salk.tickets.total, 1);
  assert.equal(salk.descuentos.promo, 1000);
  assert.equal(todo.descuentos.promo, 2000);
  assert.equal(todo.tickets.total, 2);
  assert.equal(suma(salk.pago.map((p: any) => p.total)), R.totales.ventas);
  assert.equal((await llamar(t, 'ventas', 'dias=7&tienda=narnia')).status, 400);
  // Un apartado cobrado en una caja de otra tienda no entra a la de Salk.
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, caja, creado_en, actualizado_en)
    values ('p9', 9, 'x', '1', 'tienda', 0, 'n@p.mx', 'apartado', '', 7000, 'tarjeta', 0, '', null, 'Caja 1', ?, '')`).run(`${hoy}T18:00:00.000Z`);
  const conAnticipo = (await llamar(t, 'ventas', 'dias=7')).cuerpo;
  const sinEsaCaja = (await llamar(t, 'ventas', 'dias=7&tienda=salk')).cuerpo;
  assert.equal(conAnticipo.pago.find((p: any) => p.clave === 'tarjeta').total, 7000);
  assert.equal(sinEsaCaja.pago.find((p: any) => p.clave === 'tarjeta').total, 0);
  t.db.close();
});

test('parametros invalidos y permiso: solo gerencia', async () => {
  const t = tienda();
  assert.equal((await llamar(t, 'ventas', 'dias=7&comparar=ayer')).status, 400);
  assert.equal((await llamar(t, 'ventas', 'dias=7&grano=hora')).status, 400);
  assert.equal((await llamar(t, 'ventas', 'desde=2026-02-30&hasta=2026-03-01')).status, 400);
  assert.equal((await llamar(t, 'ventas', `desde=2026-01-01&hasta=${sumarDias(hoyTienda(), 1)}`)).status, 400);
  assert.equal((await llamar(t, 'ventas', 'dias=abc')).status, 200);
  assert.equal((await t.pedir('/api/reportes/ventas', {}, 'POST')).status >= 400, true);
  assert.deepEqual(permiso('/api/reportes/ventas', 'GET'), permiso('/api/reportes', 'GET'));
  assert.deepEqual(permiso('/reportes-ventas.js', 'GET'), permiso('/reportes-resumen.js', 'GET'));
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('caja@prueba.mx', 'C', 'cajero', 1, '', '')").run();
  (t.env as unknown as Record<string, string>).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await llamar(t, 'ventas', 'dias=7')).status, 403);
  (t.env as unknown as Record<string, string>).DEV_USUARIO = DUENO;
  assert.equal((await llamar(t, 'ventas', 'dias=7')).status, 200);
  t.db.close();
});

test('privacidad: la respuesta no lleva nombres, telefonos ni correos', async () => {
  const t = tienda();
  await sembrar(t);
  const crudo = JSON.stringify((await llamar(t, 'ventas', 'dias=10')).cuerpo);
  assert.doesNotMatch(crudo, /@|prueba\.mx|nadie|rev@/);
});

test('D1 admite a lo mas 5 terminos por compound SELECT: las consultas de Ventas se quedan en cuatro o menos', () => {
  const terminos = (sql: string) => (sql.match(/union all/g) ?? []).length + 1;
  for (const conTienda of [false, true]) {
    const deCajas = (c: string) => (conTienda ? ` and ${c} in ('Caja 1')` : '');
    for (const porDia of [false, true]) assert.ok(terminos(consultaFormaPago(conTienda ? " and v.tienda = 'salk'" : '', deCajas, porDia)) <= 5, `pago ${conTienda} ${porDia}`);
    assert.ok(terminos(consultaTickets(`v.creado_en >= ? and v.creado_en < ?${conTienda ? " and v.tienda = 'salk'" : ''}`)) <= 5, `tickets ${conTienda}`);
  }
});

/* ---------- puras ---------- */

test('milesimos: enteros que suman 1000 (o 0 si no hay nada), sin decimales flotantes', () => {
  assert.deepEqual(milesimos([1, 1, 1]), [334, 333, 333]);
  assert.equal(suma(milesimos([5, 3, 2])), 1000);
  assert.deepEqual(milesimos([0, 0]), [0, 0]);
  assert.deepEqual(milesimos([100, -5]), [1000, 0]);                  // un negativo no resta: no hay parte de menos de cero
  for (let k = 0; k < 50; k++) {
    const xs = Array.from({ length: 4 }, (_, i) => Math.floor(((k + 3) * (i + 7) * 7919) % 1013));
    assert.equal(suma(milesimos(xs)), suma(xs) > 0 ? 1000 : 0);
  }
  assert.match(sqlTramoMonto('neto'), /when neto < 10000 then 0/);
});

test('armarVentas: otras categorias, canales, pago y descuentos suman lo que entra; lo que cae fuera del periodo no cuenta', () => {
  const filasMezcla = [
    { dia: '2026-11-02', canal: 'tienda', categoria: 'a', ventas: 500, piezas: 1 },
    { dia: '2026-11-02', canal: 'whatsapp', categoria: 'b', ventas: 300, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'a', ventas: 200, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'c', ventas: 100, piezas: 2 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'd', ventas: 90, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'e', ventas: 80, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'f', ventas: 70, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'g', ventas: 60, piezas: 1 },
    { dia: '2026-11-03', canal: 'tienda', categoria: 'h', ventas: 50, piezas: 1 },
    { dia: '2026-10-30', canal: 'tienda', categoria: 'a', ventas: 9999, piezas: 1 },     // la comparacion: solo cuenta sus dias
  ];
  const r = armarVentas({
    desde: '2026-11-02', hasta: '2026-11-03', grano: 'dia', ventana: { desde: '2026-10-30', hasta: '2026-10-31', dias: 2 },
    filasMezcla, filasPago: [{ dia: '2026-11-02', forma_pago: 'efectivo', total: 800 }, { dia: '2026-11-03', forma_pago: 'rara', total: 650 }, { dia: '2026-10-01', forma_pago: 'efectivo', total: 9 }],
    filasDescuento: [{ dia: '2026-11-03', promo_tickets: 1, promo: 100, otros_tickets: 2, otros: 250 }],
    filasTickets: [{ k: 'monto', b: 0, n: 2, total: 800 }, { k: 'monto', b: 3, n: 1, total: 650 }, { k: 'piezas', b: 1, n: 2, total: 800 }, { k: 'piezas', b: 6, n: 1, total: 650 },
      { k: 'mediana', b: 2, n: 300, total: 3 }, { k: 'mediana', b: 3, n: 500, total: 3 }],
  });
  assert.equal(r.categorias.length, MAX_CATEGORIAS + 1);
  assert.deepEqual(r.categorias.slice(0, 3).map((c: any) => c.categoria), ['a', 'b', 'c']);
  assert.equal(r.categorias.at(-1).otras, 2);                                      // las categorias g y h
  assert.equal(r.categorias.at(-1).total, 110);
  assert.equal(sumaSeries(r.categorias, 0), 800);
  assert.equal(sumaSeries(r.categorias, 1), 650);
  assert.equal(r.cubetas[1].ventas, 650);
  assert.deepEqual(r.canales.map((c: any) => [c.clave, c.total]), [['tienda', 500 + 650], ['whatsapp', 300], ['revendedoras', 0]]);
  assert.equal(r.pago.find((p: any) => p.clave === 'otra').total, 650);             // una forma desconocida no se pierde
  assert.equal(r.pago.find((p: any) => p.clave === 'efectivo').total, 800);          // el cobro fuera del periodo no entra
  assert.equal(r.descuentos.otros, 250);
  assert.equal(r.dias_con_venta.periodo, 2);
  assert.equal(r.dias_con_venta.anterior, 1);
  assert.equal(r.tickets.total, 3);
  assert.equal(r.tickets.mediana, 400);                                            // el promedio de los dos del centro
  assert.equal(r.tickets.bajo_umbral, 2);
  assert.equal(armarVentas({ desde: '2026-11-02', hasta: '2026-11-02', grano: 'dia', ventana: null, filasMezcla: [], filasPago: [], filasDescuento: [], filasTickets: [] }).tickets.mediana, null);
});

const respuesta = (extra: Record<string, unknown> = {}, extraV: Record<string, unknown> = {}) => {
  const cubetas = ['2026-11-02', '2026-11-03', '2026-11-04'].map((d, i) => ({ desde: d, hasta: d, dias: 1, parcial: false, ventas: 1000 * (i + 1), tickets: i + 1, piezas: 2 * (i + 1), descuento: 100 * i, gastos: 0, anterior: null }));
  const d: any = { periodo: { desde: '2026-11-02', hasta: '2026-11-04', dias: 3 }, comparar: 'anterior', comparacion: { desde: '2026-10-30', hasta: '2026-11-01', dias: 3 }, grano: 'dia',
    totales: { ventas: 6000, tickets: 6, piezas: 12, descuento: 300, gastos: 0 }, anterior: { ventas: 4000, tickets: 4, piezas: 8, descuento: 400, gastos: 0 },
    cubetas, meta: { solo_negocio: true }, meta_mes: '2026-11', retiros_sin_clasificar: null, ...extra };
  const v: any = {
    cubetas: cubetas.map((c, i) => ({ ...c, dias_con_venta: i === 1 ? 0 : 1 })),
    dias_con_venta: { periodo: 2, anterior: 3 },
    categorias: [{ categoria: 'ropa', total: 4000, piezas: 6, valores: [1000, 0, 3000] }, { categoria: '<img src=x onerror=1>', total: 2000, piezas: 6, valores: [0, 0, 2000] }, { categoria: 'otras', otras: 3, total: 0, piezas: 0, valores: [0, 0, 0] }],
    canales: [{ clave: 'tienda', total: 6000, valores: [1000, 2000, 3000] }, { clave: 'whatsapp', total: 0, valores: [0, 0, 0] }, { clave: 'revendedoras', total: 0, valores: [0, 0, 0] }],
    pago: [{ clave: 'efectivo', total: 4500, valores: [1000, 1500, 2000] }, { clave: 'tarjeta', total: 1500, valores: [0, 500, 1000] }, { clave: 'transferencia', total: 0, valores: [0, 0, 0] },
      { clave: 'dolarones', total: 0, valores: [0, 0, 0] }, { clave: 'otra', total: 0, valores: [0, 0, 0] }],
    descuentos: { promo: 100, otros: 200, promo_tickets: 1, otros_tickets: 2, valores: [{ promo: 0, otros: 0, promo_tickets: 0, otros_tickets: 0 }, { promo: 100, otros: 0, promo_tickets: 1, otros_tickets: 0 }, { promo: 0, otros: 200, promo_tickets: 0, otros_tickets: 2 }] },
    tickets: { total: 6, mediana: 15000, umbral: 10_000, bajo_umbral: 1, monto: [1, 2, 2, 1, 0, 0, 0].map((n) => ({ n, total: n * 100 })), piezas: [1, 2, 1, 1, 1, 0].map((n) => ({ n, total: n * 100 })) },
    ...extraV };
  return { d, v };
};

test('las tarjetas: 8, con las de Resumen reusadas y lo nuevo (bruto, piezas, venta por dia con venta)', () => {
  const { d, v } = respuesta();
  const k = tarjetasVentas(d, v);
  assert.deepEqual(k.map((x: any) => x.clave), ['ventas', 'bruto', 'piezas_total', 'tickets', 'ticket', 'piezas', 'dia_promedio', 'descuento']);
  const por = Object.fromEntries(k.map((x: any) => [x.clave, x]));
  assert.equal(por.ventas.valor, '$60.00');
  assert.equal(por.ventas.avance, null);
  assert.equal(por.bruto.valor, '$63.00');                                     // 6000 + 300
  assert.equal(por.bruto.cambio.texto, '+43.2%');                              // 6300 contra 4400
  assert.equal(por.piezas_total.valor, '12');
  assert.equal(por.ticket.valor, '$10.00');
  assert.equal(por.dia_promedio.valor, '$30.00');                              // 6000 / 2 dias con venta
  assert.equal(por.dia_promedio.cambio.texto, '+125.1%');                      // contra 4000 / 3 = 1333
  assert.deepEqual(por.dia_promedio.serie, [1000, null, 3000]);                // un dia sin venta no es un cero
  assert.equal(por.descuento.cambio.tono, 'bien');                             // el descuento sobre bruto baja de 9.1 % a 4.8 %: bueno
  const html = tarjetasHtml(k);
  assert.equal((html.match(/class="tarjeta kpi"/g) ?? []).length, 8);
  assert.match(html, /2 días con ventas de 3/);
  // Sin comparar o sin dias con venta de la comparacion: lo dice y no inventa.
  const sin = respuesta({ comparacion: null, anterior: null, comparar: 'ninguna' }, { dias_con_venta: { periodo: 2, anterior: null } });
  assert.match(tarjetasHtml(tarjetasVentas(sin.d, sin.v)), /Sin comparar/);
  const vacia = respuesta({ totales: { ventas: 0, tickets: 0, piezas: 0, descuento: 0, gastos: 0 } }, { dias_con_venta: { periodo: 0, anterior: 0 } });
  assert.equal(tarjetasVentas(vacia.d, vacia.v)[6].valor, '—');
});

test('las graficas: canales sin ventas se dicen y no se dibujan, el pago cierra en 100 %, y todo se escapa', () => {
  const { d, v } = respuesta();
  const g = graficas(d, v, () => 640, (c: string) => c);
  assert.match(g.categorias, /<svg/);
  assert.doesNotMatch(g.categorias, /<img/);
  assert.doesNotMatch(g.categorias, /Otras/);                                   // «otras» sin ventas no estorba la leyenda
  assert.match(g.canales, /<svg/);
  assert.doesNotMatch(g.canales, /WhatsApp|Revendedoras/);                      // sin ventas: ni leyenda ni columna
  assert.match(notaCanales(v), /Sin ventas por WhatsApp ni Revendedoras en este periodo/);
  assert.match(notaCanales(v), /Mercado Libre va aparte/);
  assert.match(g.pago, /100,0 %|100\.0 %/);                                     // el globo suma 100 %
  assert.doesNotMatch(g.pago, /Transferencia|Dolarones/);
  assert.match(g.descuentos, /Descuentos aprobados/);
  assert.match(g.tickets_monto, /<svg/);
  assert.match(g.tickets_piezas, /6\+/);
  assert.match(notaCategorias(v), /categorías que más vendieron/);
  assert.match(textoTickets(v), /mitad de los tickets es de \$150\.00 o menos/);
  assert.match(textoTickets(v), /16\.7 %|16,7 %/);
  assert.match(textoTickets(v), /\$100/);
  assert.equal(textoTickets({ tickets: { total: 0 } } as any), '');
  assert.doesNotMatch(tablaCategorias(d, v), /<img/);
  for (const t of [tablaCategorias(d, v), tablaCanales(d, v), tablaPago(d, v), tablaDescuentos(d, v), tablaTickets(v)]) assert.match(t, /<table/);
  assert.match(tablaPago(d, v), /33,3 %|33\.3 %/);                               // 500 de 1500 en el segundo dia
  assert.equal(datosCategorias(v).length, 2);
  // Con muchisimas columnas no se dibuja una grafica ilegible: se pide otra agrupacion.
  const muchas = respuesta();
  const cubetas = Array.from({ length: MAX_COLUMNAS + 1 }, (_, i) => ({ desde: sumarDias('2026-01-01', i), hasta: sumarDias('2026-01-01', i), dias: 1, parcial: false, ventas: 100, dias_con_venta: 1 }));
  muchas.v.cubetas = cubetas;
  muchas.v.categorias = [{ categoria: 'ropa', total: 100, piezas: 1, valores: cubetas.map(() => 1) }];
  muchas.v.canales[0].valores = cubetas.map(() => 1); muchas.v.pago[0].valores = cubetas.map(() => 1); muchas.v.pago[0].total = 5;
  muchas.v.descuentos.valores = cubetas.map(() => ({ promo: 1, otros: 0, promo_tickets: 1, otros_tickets: 0 }));
  const gm = graficas(muchas.d, muchas.v, () => 640);
  for (const clave of ['categorias', 'canales', 'pago', 'descuentos']) assert.match(gm[clave], /elige «Semana» o «Mes»/, clave);
});
