// node --test src/tablero-detalle.test.ts
// /api/tablero?vista= (Issue #610), vistas de ventas, tienda, mercancia, gastos y clientes: al centavo,
// solo agregados y nada de grupos de menos de 5 personas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { rutaTablero } from './tablero.ts';
import { cliente, CAJERO, cuenta, pedido, REVENDEDORA, sinDatosPrivados, venta, vista } from './tablero-prueba.ts';

const INVERSIONISTA = 'socio.capital@prueba.mx';
const VISTAS_A = ['ventas', 'tienda', 'mercancia', 'gastos', 'clientes'];

/** Los mismos tickets que la prueba del resumen: tienda 1,000; WhatsApp 250; una revendedora 250; uno cancelado; una pieza devuelta. */
async function sembrar(t: ReturnType<typeof tienda>) {
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  cuenta(t, REVENDEDORA, 'revendedora');
  cuenta(t, CAJERO, 'cajero');
  const v1 = await venta(t);
  const v2 = await venta(t, 2);
  const v3 = await venta(t);
  assert.equal((await t.pedir(`/api/ventas/${v3}/cancelar`, { motivo: 'motivo privado sintetico', caja: 'Caja 1' })).status, 200);
  const v4 = await venta(t, 2);
  const linea = (await t.pedir(`/api/ventas/${v4}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${v4}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  const v5 = await venta(t);
  pedido(t, CAJERO, v5, 1);
  const v6 = await venta(t);
  pedido(t, REVENDEDORA, v6, 2);
  return [v1, v2, v3, v4, v5, v6];
}

test('ventas: semanas, canales de la semana y del cobrado a lo vendido suman al centavo con el resumen', async () => {
  const t = tienda();
  const ids = await sembrar(t);
  // Mercado Libre de esta semana: estimado con el precio publicado; el cancelado no cuenta.
  t.db.prepare("insert into ml_publicaciones (producto_id, ml_item_id, estado, precio_ml, actualizado_en) values (?, 'MLM1', 'activa', 18000, '')").run(PRODUCTO);
  const ahoraIso = new Date().toISOString();
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o1', 'MLM1', ?, 2, 'descontada', 2, ?)").run(PRODUCTO, ahoraIso);
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o2', 'MLM1', ?, 5, 'cancelada', 0, ?)").run(PRODUCTO, ahoraIso);
  // Descuentos: una promo de $20 y un descuento autorizado de $30 (la promo va sumada en `descuento`); uno cancelado no cuenta.
  t.db.prepare('update ventas set descuento = 2000, promo = 2000 where id = ?').run(ids[0]);
  t.db.prepare('update ventas set descuento = 3000 where id = ?').run(ids[1]);
  t.db.prepare('update ventas set descuento = 9900 where id = ?').run(ids[2]);

  const resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  const r = await vista(t, 'ventas');
  assert.equal(r.status, 200);
  const d = r.cuerpo;
  assert.equal(d.vista, 'ventas');
  assert.deepEqual(d.ventas, resumen.ventas);                  // el detalle y el resumen cuentan lo mismo
  assert.equal(d.ventas.total, 150000);
  assert.equal(d.ventas.semanas.reduce((s: number, w: { total: number }) => s + w.total, 0), 150000);

  const cs = d.canales_semana;
  assert.deepEqual([cs.tienda.total, cs.whatsapp.total], [100000, 50000]);   // 1 revendedora: su venta va con WhatsApp
  assert.equal(cs.whatsapp.incluye_revendedoras, true);
  assert.equal(cs.revendedoras, null);
  assert.equal(cs.tienda.total + cs.whatsapp.total, d.ventas.semana.actual.total);
  assert.deepEqual(cs.mercado_libre, { estimado: true, total: 36000, piezas: 2 });
  assert.ok(!JSON.stringify(d).includes('comision'));

  // Cobrado 2,000 = 250 + 500 + 250 (cancelado) + 500 + 250 + 250; menos 250 devueltos y 250 cancelados = 1,500.
  assert.deepEqual(d.cuadre, { cobrado: 200000, devoluciones: 25000, cancelaciones: 25000, otros_duenos: 0, vendido: 150000 });
  assert.equal(d.cuadre.vendido, d.ventas.total);
  assert.deepEqual(d.descuentos, { promo_tickets: 1, promo: 2000, otros_tickets: 1, otros: 3000 });
  sinDatosPrivados(d, ids);
  t.db.close();
});

test('ventas: con 5 revendedoras con ventas el canal se separa y sigue sumando el total', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  await venta(t);
  for (let n = 0; n < 5; n++) {
    const correo = `rev${n}@revende.mx`;
    cuenta(t, correo, 'revendedora');
    pedido(t, correo, await venta(t), 10 + n);
  }
  const d = (await vista(t, 'ventas')).cuerpo;
  assert.deepEqual(d.canales_semana.revendedoras, { total: 125000, tickets: 5 });
  assert.equal(d.canales_semana.whatsapp.incluye_revendedoras, false);
  assert.equal(d.canales_semana.tienda.total + d.canales_semana.whatsapp.total + d.canales_semana.revendedoras.total, d.ventas.total);
  sinDatosPrivados(d, []);
  assert.doesNotMatch(JSON.stringify(d), /rev\d@/);
  t.db.close();
});

test('tienda: formas de pago, dia y franja suman lo vendido en la caja; menos de 5 socios con Dolarones no se muestran', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  cuenta(t, CAJERO, 'cajero');
  const efectivo = await venta(t, 2);                          // 500
  const tarjeta = await venta(t);                              // 250
  const transferencia = await venta(t);                        // 250
  const conDolarones = await Promise.all([1, 2, 3, 4].map(() => venta(t)));   // 4 x 250, 50 pagados con Dolarones cada uno
  const porWhatsApp = await venta(t);                          // no es de la caja
  pedido(t, CAJERO, porWhatsApp, 1);
  t.db.prepare("update ventas set forma_pago = 'tarjeta' where id = ?").run(tarjeta);
  t.db.prepare("update ventas set forma_pago = 'transferencia' where id = ?").run(transferencia);
  const socios = [1, 2, 3, 4, 5].map((n) => cliente(t, n));
  const conDolar = t.db.prepare('update ventas set cliente_id = ?, dolarones = 5000 where id = ?');
  conDolarones.forEach((id, i) => conDolar.run(socios[i], id));

  let d = (await vista(t, 'tienda')).cuerpo;
  assert.equal(d.ventas_total, 225000);                        // la caja (2,000) y el pedido de WhatsApp (250)
  assert.deepEqual(d.tienda, { total: 200000, tickets: 7, ticket_promedio: Math.round(200000 / 7) });
  const p = d.pagos;
  // Con 4 socios su monto (4 x $50) se junta con «otras» y nadie puede restarlo.
  assert.equal(p.dolarones, null);
  assert.deepEqual([p.efectivo, p.tarjeta, p.transferencia], [50000 + 4 * 20000, 25000, 25000]);
  assert.equal(p.otras, 4 * 5000);
  assert.equal(p.efectivo + p.tarjeta + p.transferencia + p.otras, d.tienda.total);
  assert.equal(d.por_dia_semana.reduce((s: number, x: { total: number }) => s + x.total, 0), d.tienda.total);
  assert.equal(d.por_dia_semana.reduce((s: number, x: { tickets: number }) => s + x.tickets, 0), d.tienda.tickets);
  assert.equal(d.por_franja.manana + d.por_franja.tarde + d.por_franja.noche, d.tienda.total);
  sinDatosPrivados(d, [...conDolarones, efectivo, tarjeta, transferencia, porWhatsApp]);

  // El quinto socio: ya se puede decir cuanto se pago con Dolarones.
  conDolar.run(socios[4], (await venta(t)));
  d = (await vista(t, 'tienda')).cuerpo;
  assert.equal(d.pagos.dolarones, 5 * 5000);
  assert.equal(d.pagos.otras, 0);
  assert.equal(d.pagos.efectivo + d.pagos.tarjeta + d.pagos.transferencia + d.pagos.dolarones, d.tienda.total);
  t.db.close();
});

test('mercancia: piezas, valor y antiguedad suman con el inventario y no sueltan ninguna pieza', async () => {
  const t = tienda();
  // La pieza de la tienda de prueba: 50 en piso, capturada hace 10 dias (tramo 0-2); mas 2 de hogar de hace 70 dias (9+).
  t.db.prepare("update productos set destino = 'etiqueta', categoria = 'ropa', creado_en = ? where id = ?")
    .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), PRODUCTO);
  t.db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, destino, sin_inventario, estado_fisico, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Pieza Privada', 'hogar', 4000, 2, 'etiqueta', 0, 'nuevo', 'S40', ?, '')`)
    .run(crypto.randomUUID(), new Date(Date.now() - 70 * 86_400_000).toISOString());
  const d = (await vista(t, 'mercancia')).cuerpo;
  const i = d.inventario;
  assert.equal(i.piezas, 52);
  assert.equal(i.valor, 50 * 25000 + 2 * 4000);
  assert.deepEqual(i.por_categoria, [{ categoria: 'ropa', piezas: 50, valor: 1250000 }, { categoria: 'hogar', piezas: 2, valor: 8000 }]);
  assert.deepEqual(i.por_antiguedad.map((x: { tramo: string; piezas: number; valor: number }) => [x.tramo, x.piezas, x.valor]),
    [['0-2', 50, 1250000], ['3-4', 0, 0], ['5-8', 0, 0], ['9+', 2, 8000]]);
  assert.equal(i.sin_fecha, 0);
  assert.equal(i.por_antiguedad.reduce((s: number, x: { valor: number }) => s + x.valor, 0), i.valor);
  assert.ok(!('mas_viejas' in i));
  sinDatosPrivados(d, [PRODUCTO, 'Pieza Privada', 'ED-000002']);
  t.db.close();
});

test('gastos: la nomina es un solo total, cada gasto de caja cuenta una vez y no hay notas ni personas', async () => {
  const t = tienda();
  const hoy = hoyTienda();
  const ahoraIso = new Date().toISOString();
  const gasto = t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values (?, ?, ?, ?, 'nota privada', ?, ?, 'x', ?)");
  gasto.run(crypto.randomUUID(), hoy, 'publicidad', 10000, 'fuera', null, ahoraIso);
  gasto.run(crypto.randomUUID(), hoy, 'renta', 50000, 'fuera', null, ahoraIso);
  gasto.run(crypto.randomUUID(), hoy, 'luz', 3000, 'fuera', null, ahoraIso);
  const retiro = t.db.prepare("insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria) values (?, 'gasto', 'Caja 1', ?, ?, 'motivo privado', null, ?, ?)");
  retiro.run('r1', CAJERO, 2000, ahoraIso, 'comida_consumibles');
  retiro.run('r2', CAJERO, 1500, ahoraIso, 'limpieza');
  gasto.run(crypto.randomUUID(), hoy, 'limpieza', 1500, 'caja', 'r2', ahoraIso);
  // Dos empleados: lo pagado se suma en un solo total de nomina.
  for (const [id, pago] of [['e1', 30000], ['e2', 40000]] as const) {
    t.db.prepare("insert into empleados (id, nombre, periodo, pago_dia, creado_en) values (?, 'Empleado Privado', 'diario', ?, '')").run(id, pago);
  }
  const mov = t.db.prepare("insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, creado_por, creado_en) values (?, ?, ?, ?, ?, 'x', ?)");
  mov.run('m1', 'e1', hoy, 'devengo', 90000, ahoraIso);        // devengado: no es dinero pagado
  mov.run('m2', 'e1', hoy, 'adelanto', 20000, ahoraIso);
  mov.run('m3', 'e1', hoy, 'pago', -80000, ahoraIso);
  mov.run('m4', 'e2', hoy, 'pago', -5000, ahoraIso);

  const resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  const d = (await vista(t, 'gastos')).cuerpo;
  // 100 + 500 + 30 + 20 + 15 + nomina 1,050 (adelanto 200 + pagos 800 y 50)
  assert.equal(d.gastos.total, 171500);
  assert.equal(d.gastos.total, resumen.gastos.total);
  assert.deepEqual([d.gastos.nomina, d.gastos.renta, d.gastos.publicidad, d.gastos.otros], [105000, 50000, 10000, 6500]);
  assert.equal(d.gastos.nomina + d.gastos.renta + d.gastos.publicidad + d.gastos.otros, d.gastos.total);
  assert.deepEqual(d.gastos.otros_detalle, [
    { categoria: 'luz', importe: 3000 }, { categoria: 'comida_consumibles', importe: 2000 }, { categoria: 'limpieza', importe: 1500 },
  ]);
  assert.equal(d.gastos.otros_detalle.reduce((s: number, x: { importe: number }) => s + x.importe, 0), d.gastos.otros);
  assert.deepEqual(d.publicidad, { gasto: 10000, ventas_por_peso: 0 });      // sin ventas: $0 por cada $1 de anuncio, como en el resumen
  sinDatosPrivados(d, []);
  assert.ok(!JSON.stringify(d).includes('e1'));
  t.db.close();
});

test('clientes: solo conteos, y menos de 5 socios, de nuevos en una semana o de referidos no se cuentan', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const socios = [1, 2, 3, 4].map((n) => cliente(t, n));
  let d = (await vista(t, 'clientes')).cuerpo;
  assert.deepEqual(d.socios, { total: null, nuevos_por_semana: null, regresaron_pct: null, regresaron: null });
  assert.equal(d.dolarones_pagados, null);
  assert.equal(d.referidos, null);

  socios.push(cliente(t, 5));
  const v1 = await venta(t); const v2 = await venta(t); const v3 = await venta(t);
  const asignar = t.db.prepare('update ventas set cliente_id = ? where id = ?');
  asignar.run(socios[0], v1); asignar.run(socios[0], v2); asignar.run(socios[1], v3);
  d = (await vista(t, 'clientes')).cuerpo;
  assert.deepEqual(d.compras, { tickets: 3, ticket_promedio: 25000 });
  assert.equal(d.socios.total, 5);
  assert.equal(d.socios.regresaron_pct, 20);                   // 1 de 5 compro dos veces
  assert.equal(d.socios.regresaron, null);                     // y 1 persona no se cuenta
  assert.equal(d.socios.nuevos_por_semana.reduce((s: number, w: { nuevos: number | null }) => s + (w.nuevos ?? 0), 0), 5);   // las 5 altas son de esta semana

  // Dolarones pagados: con 4 socios distintos no se dice el monto; con el quinto, si.
  const conDolar = t.db.prepare('update ventas set cliente_id = ?, dolarones = 1000 where id = ?');
  for (let i = 0; i < 4; i++) conDolar.run(socios[i], await venta(t));
  assert.equal((await vista(t, 'clientes')).cuerpo.dolarones_pagados, null);
  conDolar.run(socios[4], await venta(t));
  assert.equal((await vista(t, 'clientes')).cuerpo.dolarones_pagados, 5 * 1000);

  // Referidos: 5 llegaron con codigo, 2 ya compraron; con menos de 5 en un grupo solo se dice el total.
  const referente = cliente(t, 6);
  const nuevos = [7, 8, 9, 10, 11].map((n) => cliente(t, n));
  nuevos.forEach((nuevo, i) => t.db.prepare("insert into referidos (nuevo_id, referente_id, estado, creado_en) values (?, ?, ?, '')")
    .run(nuevo, referente, i < 2 ? 'liberado' : 'pendiente'));
  t.db.prepare("insert into dolarones_movimientos (cliente_id, lote_id, tipo, importe, autor, creado_en) values (?, 'l', 'alta_referido', 5000, 'portal', '')").run(nuevos[0]);
  d = (await vista(t, 'clientes')).cuerpo;
  assert.deepEqual(d.referidos, { total: 5, liberados: null, pendientes: null, dolarones_regalados: 5000, reglas: d.referidos.reglas });
  assert.deepEqual(Object.keys(d.referidos.reglas), ['alta', 'premio', 'minimo_compra', 'maximo_por_socio']);
  sinDatosPrivados(d, [v1, v2, v3, ...socios, referente, ...nuevos]);
  t.db.close();
});

test('vistas: una que no existe es 404, solo se lee con GET y cada vista tiene su propia cache con el host', async () => {
  const t = tienda();
  for (const nombre of ['no-existe', 'constructor', '__proto__', 'toString', '']) {
    const r = await vista(t, nombre);
    assert.equal(r.status, 404, nombre);
    assert.equal(JSON.stringify(r.cuerpo).includes('Vista'), true);
  }
  assert.equal((await t.pedir('/api/tablero?vista=ventas', {}, 'POST')).status, 405);   // el dueno pasa el permiso; la ruta solo lee
  assert.equal((await t.pedir('/api/tablero/ventas', undefined, 'GET')).status, 404);     // la ruta es una sola

  // Una cache en memoria en lugar de caches.default: la llave lleva el host y la vista.
  const guardado = new Map<string, string>();
  const falsa = { match: async (req: Request) => (guardado.has(req.url) ? new Response(guardado.get(req.url)) : undefined),
    put: async (req: Request, res: Response) => { guardado.set(req.url, await res.text()); } };
  (globalThis as unknown as { caches: unknown }).caches = { default: falsa };
  try {
    const hechas: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => hechas.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    for (const nombre of VISTAS_A) {
      const r = await rutaTablero(new Request(`https://caja.prueba/api/tablero?vista=${nombre}`), t.env, ctx);
      assert.equal(r.status, 200, nombre);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    await rutaTablero(new Request('https://otro.prueba/api/tablero?vista=ventas'), t.env, ctx);
    await Promise.all(hechas);
    assert.deepEqual([...guardado.keys()].sort(), [
      ...VISTAS_A.map((n) => `https://caja.prueba/api/tablero/cache-v1/${n}`), 'https://otro.prueba/api/tablero/cache-v1/ventas',
    ].sort());
    // La segunda lectura sale de la cache: se nota porque la base ya no se consulta.
    const cerrada = { ...t.env, DB: { prepare() { throw new Error('no debe consultar'); } } } as unknown as Env;
    assert.equal((await rutaTablero(new Request('https://caja.prueba/api/tablero?vista=tienda'), cerrada, ctx)).status, 200);
    assert.equal((await rutaTablero(new Request('https://caja.prueba/api/tablero?vista=nada'), cerrada, ctx)).status, 404);
  } finally {
    delete (globalThis as unknown as { caches?: unknown }).caches;
  }
  t.db.close();
});

test('el inversionista lee cada vista y un cajero no', async () => {
  const t = tienda();
  cuenta(t, INVERSIONISTA, 'inversionista');
  cuenta(t, CAJERO, 'cajero');
  const como = (correo: string) => { (t.env as unknown as Record<string, string>).DEV_USUARIO = correo; };
  for (const nombre of VISTAS_A) {
    como(INVERSIONISTA);
    const r = await t.enviar(`/api/tablero?vista=${nombre}`);
    assert.equal(r.status, 200, nombre);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    como(CAJERO);
    assert.equal((await t.enviar(`/api/tablero?vista=${nombre}`)).status, 403, nombre);
  }
  como(INVERSIONISTA);
  assert.equal((await t.enviar('/api/tablero?vista=no-existe')).status, 404);   // permitido leer, pero esa vista no existe
  assert.equal((await t.enviar('/api/tablero/ventas')).status, 403);        // la vista no va en el camino
  assert.equal((await t.enviar('/api/tablero?vista=ventas', {}, 'POST')).status, 403);
  t.db.close();
});
