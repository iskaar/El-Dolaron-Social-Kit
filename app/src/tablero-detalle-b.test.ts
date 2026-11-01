// node --test src/tablero-detalle-b.test.ts
// /api/tablero?vista= (Issue #610), vistas de WhatsApp, revendedoras y Mercado Libre: al centavo, solo agregados,
// y las revendedoras no existen como vista con menos de 5 con ventas en el mes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { DIAS_APARTADO, HORAS_REVENDEDORA } from './pedidos.ts';
import { ANTICIPO } from '../public/venta.js';
import { CAJERO, cuenta, pedido, REVENDEDORA, sinDatosPrivados, venta, vista, type T } from './tablero-prueba.ts';

let folio = 100;
type Apartado = { estado: string; entrega?: string; vendedora?: string; envio?: number; saldo?: number; guia?: string; precio?: number; cantidad?: number };
/** Un pedido de este mes con una linea al precio pactado (centavos). */
function apartado(t: T, p: Apartado) {
  const id = crypto.randomUUID();
  const ahora = new Date().toISOString();
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago,
      saldo, saldo_vence_en, guia, creado_en, actualizado_en)
    values (?, ?, 'Carla Privada Sintetica', '4441230000', ?, ?, ?, ?, '', 0, 'efectivo', ?, '', ?, ?, ?)`)
    .run(id, ++folio, p.entrega ?? 'tienda', p.envio ?? 0, p.vendedora ?? CAJERO, p.estado, p.saldo ?? 0, p.guia ?? '', ahora, ahora);
  t.db.prepare('insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values (?, ?, ?, ?)').run(id, PRODUCTO, p.cantidad ?? 1, p.precio ?? 25000);
  return id;
}

async function conVenta(t: T, vendedora: string) {
  const v = await venta(t);
  pedido(t, vendedora, v, ++folio);
  return v;
}

test('whatsapp: con una revendedora sus pedidos van sumados; cada cifra cuadra y no hay datos de personas', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  cuenta(t, CAJERO, 'cajero');
  cuenta(t, REVENDEDORA, 'revendedora');
  const v1 = await conVenta(t, CAJERO);                        // cerrado $250
  const v2 = await conVenta(t, REVENDEDORA);                   // cerrado de revendedora $250
  apartado(t, { estado: 'vendido' });
  apartado(t, { estado: 'vendido', entrega: 'envio', envio: 9900 });                // envio ya pagado sin guia
  apartado(t, { estado: 'vendido', entrega: 'envio', envio: 9900, guia: 'GUIA-PRIVADA-1' });
  apartado(t, { estado: 'apartado', cantidad: 2, saldo: 10000 });                   // $500, pagado $100, falta $400
  apartado(t, { estado: 'apartado', entrega: 'envio', envio: 9900, saldo: 10000 }); // $349, pagado $100, falta $249
  apartado(t, { estado: 'apartado', vendedora: REVENDEDORA, saldo: 0 });            // revendedora: $250, falta $250
  apartado(t, { estado: 'vencido' });
  apartado(t, { estado: 'cancelado' });
  apartado(t, { estado: 'cancelado', vendedora: REVENDEDORA });

  const resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  const d = (await vista(t, 'whatsapp')).cuerpo;
  assert.equal(d.canal.incluye_revendedoras, true);
  assert.equal(d.canal.total, resumen.canales.whatsapp.total);                      // el mismo numero que el resumen
  assert.equal(d.canal.total, 50000);
  assert.equal(d.canal.tickets, 2);
  assert.equal(d.canal.ticket_promedio, 25000);
  // Pedidos de este mes: 3 vendidos + 3 apartados + 1 vencido + 2 cancelados = 9 (mas los dos de las ventas, vendidos con creado_en vacio: no cuentan)
  assert.deepEqual(d.pedidos_mes, { total: 9, cerrados: 3, abiertos: 3, vencidos: 1, cancelados: 2 });
  assert.deepEqual(d.apartados, { abiertos: 3, valor: 50000 + 34900 + 25000, pagado: 20000, falta: 40000 + 24900 + 25000 });
  assert.equal(d.apartados.valor - d.apartados.pagado, d.apartados.falta);
  assert.deepEqual(d.entrega, { tienda: 6, envio: 3, envios_pendientes: 1 });   // 2 envios vendidos y 1 apartado; solo 1 vendido sin guia
  // Las reglas son las del codigo, no numeros repetidos aqui.
  assert.deepEqual(d.reglas, { dias_apartado: DIAS_APARTADO, horas_revendedora: HORAS_REVENDEDORA, anticipo: ANTICIPO });
  sinDatosPrivados(d, [v1, v2, 'GUIA-PRIVADA-1']);
  t.db.close();
});

test('whatsapp: con 5 revendedoras con ventas sus pedidos salen de WhatsApp', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  cuenta(t, CAJERO, 'cajero');
  await conVenta(t, CAJERO);
  apartado(t, { estado: 'apartado', saldo: 5000 });
  for (let n = 0; n < 5; n++) {
    const correo = `rev${n}@revende.mx`;
    cuenta(t, correo, 'revendedora');
    await conVenta(t, correo);
    apartado(t, { estado: 'apartado', vendedora: correo });
    apartado(t, { estado: 'vendido', vendedora: correo });
  }
  const d = (await vista(t, 'whatsapp')).cuerpo;
  assert.equal(d.canal.incluye_revendedoras, false);
  assert.equal(d.canal.total, 25000);
  assert.deepEqual(d.pedidos_mes, { total: 1, cerrados: 0, abiertos: 1, vencidos: 0, cancelados: 0 });
  assert.deepEqual(d.apartados, { abiertos: 1, valor: 25000, pagado: 5000, falta: 20000 });
  assert.doesNotMatch(JSON.stringify(d), /rev\d@/);
  t.db.close();
});

test('revendedoras: con menos de 5 con ventas la vista no existe; con 5, solo agregados', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  for (let n = 0; n < 4; n++) {
    const correo = `rev${n}@revende.mx`;
    cuenta(t, correo, 'revendedora');
    await conVenta(t, correo);
  }
  apartado(t, { estado: 'apartado', vendedora: 'rev0@revende.mx' });
  let d = (await vista(t, 'revendedoras')).cuerpo;
  // Ni cuantas son, ni cuanto vendieron, ni comision: solo que no hay vista.
  assert.deepEqual(Object.keys(d).sort(), ['disponible', 'generado_en', 'mes', 'vista']);
  assert.equal(d.disponible, false);
  assert.doesNotMatch(JSON.stringify(d), /comision|personas|total/);

  const quinta = 'rev4@revende.mx';
  cuenta(t, quinta, 'revendedora');
  const v5 = await conVenta(t, quinta);
  apartado(t, { estado: 'apartado', vendedora: quinta, cantidad: 3 });
  const resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  d = (await vista(t, 'revendedoras')).cuerpo;
  assert.equal(d.disponible, true);
  assert.equal(d.personas, 5);
  assert.equal(d.pedidos, 5);
  assert.equal(d.total, 125000);
  assert.equal(d.total, resumen.canales.revendedoras.total);
  assert.equal(d.ticket_promedio, 25000);
  assert.equal(d.comision, 5 * 2500);                          // 10 % del precio, por pedido
  assert.equal(d.comision, resumen.canales.revendedoras.comision);
  assert.equal(d.comision_pct, 10);
  assert.deepEqual(d.categorias, [{ categoria: 'sin categoria', total: 125000 }]);
  assert.deepEqual(d.apartados_abiertos, { n: 2, valor: 25000 + 75000 });
  sinDatosPrivados(d, [v5]);
  assert.doesNotMatch(JSON.stringify(d), /rev\d@/);
  t.db.close();
});

test('mercadolibre: estimado con el precio publicado, sin ordenes ni enlaces', async () => {
  const t = tienda();
  const dia = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  t.db.prepare("update productos set categoria = 'hogar' where id = ?").run(PRODUCTO);
  t.db.prepare("insert into ml_publicaciones (producto_id, ml_item_id, estado, precio_ml, permalink, publicado_en, actualizado_en) values (?, 'MLM-PRIVADO-1', 'activa', 18000, 'https://articulo.mercadolibre.com.mx/MLM-PRIVADO-1', ?, '')")
    .run(PRODUCTO, dia(0.5 + 6));
  const orden = t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, atendida_en, recibido_en) values (?, 'MLM-PRIVADO-1', ?, ?, ?, ?, ?, ?)");

  // Con menos de 3 ventas con fecha de publicacion no se dice el promedio.
  orden.run('ord-privada-1', PRODUCTO, 2, 'descontada', 2, '', new Date().toISOString());
  let d = (await vista(t, 'mercadolibre')).cuerpo;
  assert.equal(d.dias_en_venderse, null);

  orden.run('ord-privada-2', PRODUCTO, 1, 'descontada', 1, '2026-01-01T00:00:00Z', new Date().toISOString());
  orden.run('ord-privada-3', PRODUCTO, 1, 'recibida', 0, '', new Date().toISOString());
  orden.run('ord-privada-4', PRODUCTO, 5, 'cancelada', 0, '', new Date().toISOString());
  const resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  d = (await vista(t, 'mercadolibre')).cuerpo;
  assert.equal(d.estimado, true);
  assert.deepEqual(d.vendido, { total: 4 * 18000, piezas: 4, piezas_reales: 0 });
  assert.equal(d.queda, null);                       // la cancelada no cuenta
  assert.equal(d.vendido.total, resumen.canales.mercado_libre.total);
  assert.deepEqual(d.publicaciones, { publicadas: 1, activas: 1, con_venta: 1 });
  assert.deepEqual(d.por_categoria, [{ categoria: 'hogar', piezas: 4, total: 72000, piezas_reales: 0 }]);
  assert.equal(d.por_categoria.reduce((s: number, c: { total: number }) => s + c.total, 0), d.vendido.total);
  assert.equal(d.por_atender, 2);                                                      // la atendida y la cancelada no
  assert.equal(d.canceladas, 1);
  assert.ok(d.dias_en_venderse >= 5 && d.dias_en_venderse <= 7, String(d.dias_en_venderse));
  sinDatosPrivados(d, ['MLM-PRIVADO-1', 'ord-privada', 'articulo.mercadolibre']);
  t.db.close();
});

test('mercadolibre (#621): el precio real manda, el estimado solo donde falta, y «lo que nos queda» solo cuenta filas con los tres datos', async () => {
  const t = tienda();
  t.db.prepare("insert into ml_publicaciones (producto_id, ml_item_id, estado, precio_ml, permalink, publicado_en, actualizado_en) values (?, 'MLM-PRIVADO-1', 'activa', 18000, 'https://articulo.mercadolibre.com.mx/MLM-PRIVADO-1', '', '')")
    .run(PRODUCTO);
  const ahora = new Date().toISOString();
  const fila = t.db.prepare(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en, precio_unitario, comision_unitaria, envio_vendedor)
    values (?, 'MLM-PRIVADO-1', ?, ?, ?, 0, ?, ?, ?, ?)`);
  fila.run('ord-privada-1', PRODUCTO, 2, 'descontada', ahora, 15000, 2250, 8450);       // los tres datos
  fila.run('ord-privada-2', PRODUCTO, 1, 'descontada', ahora, 9900, null, null);        // solo precio
  fila.run('ord-privada-3', PRODUCTO, 1, 'descontada', ahora, null, null, null);        // nada: estimado con 18000
  fila.run('ord-privada-4', PRODUCTO, 5, 'cancelada', ahora, 15000, 2250, 8450);        // cancelada: no cuenta
  let resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  let d = (await vista(t, 'mercadolibre')).cuerpo;
  assert.equal(d.estimado, true);
  assert.deepEqual(d.vendido, { total: 2 * 15000 + 9900 + 18000, piezas: 4, piezas_reales: 3 });
  assert.deepEqual(resumen.canales.mercado_libre, { estimado: true, total: 57900, piezas: 4, piezas_reales: 3 });
  assert.deepEqual(d.queda, { piezas: 2, vendido: 30000, comision: 4500, envio: 8450, queda: 30000 - 4500 - 8450 });
  assert.deepEqual(d.por_categoria.map((c: { total: number; piezas_reales: number }) => [c.total, c.piezas_reales]), [[57900, 3]]);
  // Tampoco entra en las ventas de la tienda.
  assert.equal(resumen.ventas.total, 0);
  sinDatosPrivados(d, ['MLM-PRIVADO-1', 'ord-privada', 'articulo.mercadolibre']);
  sinDatosPrivados(resumen, ['MLM-PRIVADO-1', 'ord-privada']);

  // Con todo leido ya no es estimado y se ve el neto de las cuatro piezas.
  t.db.prepare("update ml_ventas set precio_unitario = 9900, comision_unitaria = 1485, envio_vendedor = 0 where order_id in ('ord-privada-2', 'ord-privada-3')").run();
  t.db.prepare('delete from ml_ventas where order_id = ?').run('ord-privada-4');
  resumen = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  d = (await vista(t, 'mercadolibre')).cuerpo;
  assert.equal(d.estimado, false);
  assert.equal(resumen.canales.mercado_libre.estimado, false);
  assert.equal(d.vendido.total, 2 * 15000 + 2 * 9900);
  assert.deepEqual(d.queda, { piezas: 4, vendido: 49800, comision: 4500 + 2 * 1485, envio: 8450, queda: 49800 - 7470 - 8450 });
  t.db.close();
});

test('las tres vistas nuevas las lee el inversionista, no un cajero, y tienen su propia cache', async () => {
  const t = tienda();
  const INVERSIONISTA = 'socio.capital@prueba.mx';
  cuenta(t, INVERSIONISTA, 'inversionista');
  cuenta(t, CAJERO, 'cajero');
  const como = (correo: string) => { (t.env as unknown as Record<string, string>).DEV_USUARIO = correo; };
  for (const nombre of ['whatsapp', 'revendedoras', 'mercadolibre']) {
    como(INVERSIONISTA);
    const r = await t.enviar(`/api/tablero?vista=${nombre}`);
    assert.equal(r.status, 200, nombre);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    como(CAJERO);
    assert.equal((await t.enviar(`/api/tablero?vista=${nombre}`)).status, 403, nombre);
    como(INVERSIONISTA);
    assert.equal((await t.enviar(`/api/tablero?vista=${nombre}`, {}, 'POST')).status, 403, nombre);
  }
  t.db.close();
});
