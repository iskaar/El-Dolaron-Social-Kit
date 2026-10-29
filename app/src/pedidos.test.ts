// node --test src/pedidos.test.ts
// Pedidos por WhatsApp, fase 1 (Issue #269) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { tienda, PRODUCTO, codigoPrueba, datosTransferencia } from './prueba-d1.ts';
import { permiso } from './cuentas.ts';
import { PUBLICABLE } from './mercadolibre.ts';
import { vencerPedidos, telefonoDe } from './pedidos.ts';
import { viernesDeEnvio } from '../public/venta.js';
import worker from './worker.ts';

// PRODUCTO vale $250 y hay 50. Los demas se crean aqui.
let consecutivo = 100;
function pieza(db: DatabaseSync, precio: number, stock: number) {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
              values (?, ?, ?, ?, ?, 'listo', 'fotos/x.jpg', 'S40', '', '')`)
    .run(id, `ED-${String(++consecutivo).padStart(6, '0')}`, `Pieza ${consecutivo}`, precio, stock);
  return id;
}
const stockDe = (db: DatabaseSync, id: string) => (db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
const publicables = (db: DatabaseSync, id: string) =>
  (db.prepare(`select count(*) as n from productos p where ${PUBLICABLE} and p.id = ?`).get(id) as { n: number }).n;

const apartar = (pedir: ReturnType<typeof tienda>['pedir'], extra: Record<string, unknown> = {}) => {
  const cuerpo = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente: 'Ana', telefono: '4441234567',
    entrega: 'tienda', anticipo: 10000, forma_pago: 'transferencia', caja: 'Caja 1', ...extra,
  };
  // Toda transferencia lleva su clave de rastreo (#593): sintetica y unica salvo que la prueba ponga la suya.
  if (cuerpo.forma_pago === 'transferencia' && !('clave_rastreo' in extra)) Object.assign(cuerpo, datosTransferencia(Number(cuerpo.anticipo)));
  return pedir('/api/pedidos', cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const vender = (pedir: ReturnType<typeof tienda>['pedir'], extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra,
  };
  return pedir('/api/ventas', venta).then((r) => ({ ...r, id: venta.id as string }));
};

const paquete = (pedir: ReturnType<typeof tienda>['pedir'], extra: Record<string, unknown> = {}) => apartar(pedir, { entrega: 'envio', ...extra });
const abonar = (pedir: ReturnType<typeof tienda>['pedir'], folio: number, importe: number, extra: Record<string, unknown> = {}) =>
  pedir(`/api/pedidos/${folio}/abonos`, { id: crypto.randomUUID(), importe, forma_pago: 'efectivo', caja: 'Caja 1',
    ...(extra.forma_pago === 'transferencia' && !('clave_rastreo' in extra) ? datosTransferencia(importe) : {}), ...extra });
const agregarAPaquete = (pedir: ReturnType<typeof tienda>['pedir'], folio: number, producto_id: string, extra: Record<string, unknown> = {}) =>
  pedir(`/api/pedidos/${folio}/piezas`, { id: crypto.randomUUID(), producto_id, cantidad: 1, ...extra });

/** Ambas solicitudes llegan al batch con lecturas previas: la segunda debe perder dentro del SQL. */
function juntarDosBatches(env: Env) {
  const batch = env.DB.batch.bind(env.DB);
  let llegaron = 0;
  let liberar!: () => void;
  const juntas = new Promise<void>((r) => { liberar = r; });
  env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    if (++llegaron === 2) liberar();
    await juntas;
    return batch(sentencias);
  }) as typeof env.DB.batch;
}

test('crear un pedido aparta la pieza: baja la existencia, la saca de lo publicable y no se duplica al reintentar', async () => {
  const { db, pedir } = tienda();
  const a = pieza(db, 10000, 3);
  assert.equal(publicables(db, a), 1);
  const r = await apartar(pedir, { lineas: [{ producto_id: a, cantidad: 3 }], anticipo: 30000 });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const p = r.cuerpo.pedido;
  assert.equal(p.folio, 1);
  assert.equal(p.estado, 'apartado');
  assert.equal(p.saldo, 30000);
  assert.equal(p.subtotal, 30000);
  assert.equal(p.vendedora, 'dueno@prueba.mx');
  assert.equal(p.lineas[0].codigo.startsWith('ED-'), true);
  assert.equal(Math.round((Date.parse(p.vence_en) - Date.parse(p.creado_en)) / 86_400_000), 7);
  assert.equal(stockDe(db, a), 0);
  assert.equal(publicables(db, a), 0);

  const otra = await pedir('/api/pedidos', { ...r.cuerpo.pedido, id: r.id, lineas: [{ producto_id: a, cantidad: 3 }] });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.pedido.folio, 1);
  assert.equal(stockDe(db, a), 0);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);

  const siguiente = await apartar(pedir);
  assert.equal(siguiente.cuerpo.pedido.folio, 2);
  assert.equal((await pedir('/api/pedidos/2', undefined, 'GET')).cuerpo.pedido.cliente, 'Ana');
  assert.equal((await pedir('/api/pedidos/99', undefined, 'GET')).status, 404);
});

test('dos pedidos por la ultima pieza: uno gana y el otro recibe 409 sin dejar nada a medias', async () => {
  const { db, pedir } = tienda();
  const ultima = pieza(db, 20000, 1);
  const uno = await apartar(pedir, { lineas: [{ producto_id: ultima, cantidad: 1 }, { producto_id: PRODUCTO, cantidad: 1 }] });
  const dos = await apartar(pedir, { lineas: [{ producto_id: ultima, cantidad: 1 }, { producto_id: PRODUCTO, cantidad: 1 }] });
  assert.equal(uno.status, 201);
  assert.equal(dos.status, 409);
  assert.match(dos.cuerpo.error, /ya no está disponible/);
  assert.equal(stockDe(db, PRODUCTO), 49);   // el batch del perdedor se deshizo completo
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);
});

test('reglas del pedido: 15% local, $100 al abrir envío, tarifa, teléfono, etiquetas y caja para todo cobro', async () => {
  const { db, pedir } = tienda();
  assert.equal(telefonoDe('+52 (444) 123-4567'), '4441234567');
  assert.equal(telefonoDe('123'), null);

  assert.equal((await apartar(pedir, { anticipo: 3799 })).status, 400);
  assert.equal((await apartar(pedir, { anticipo: 3800 })).status, 201);           // $250 × 15% = $37.50 → $38
  assert.equal((await apartar(pedir, { anticipo: 25001 })).status, 400);          // pasa del total
  assert.equal((await apartar(pedir, { cliente: '  ' })).status, 400);
  assert.equal((await apartar(pedir, { telefono: '12345' })).status, 400);
  assert.equal((await apartar(pedir, { entrega: 'correo' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'cheque' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'efectivo', caja: '' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'tarjeta', caja: '' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'transferencia', caja: '' })).status, 400);
  assert.equal((await apartar(pedir, { lineas: [] })).status, 400);
  assert.equal((await apartar(pedir, { lineas: [{ producto_id: crypto.randomUUID(), cantidad: 1 }] })).status, 400);
  const banda = (db.prepare(`select id from productos where sin_inventario = 1 limit 1`).get() as { id: string }).id;
  const sinEtiqueta = await apartar(pedir, { lineas: [{ producto_id: banda, cantidad: 1 }] });
  assert.equal(sinEtiqueta.status, 400);
  assert.equal(sinEtiqueta.cuerpo.error, 'Solo piezas con etiqueta.');
  assert.equal(stockDe(db, PRODUCTO), 49);

  // $250 + $99 de envío = $349: abre con $100, quedan $249.
  assert.equal((await apartar(pedir, { entrega: 'envio', anticipo: 9999 })).status, 400);
  assert.equal((await apartar(pedir, { entrega: 'envio', anticipo: 10001 })).status, 400);
  const envio = await apartar(pedir, { entrega: 'envio', anticipo: 10000, telefono: '524441234567' });
  assert.equal(envio.status, 201, JSON.stringify(envio.cuerpo));
  assert.equal(envio.cuerpo.pedido.envio, 9900);
  assert.equal(envio.cuerpo.pedido.telefono, '4441234567');
  assert.equal(envio.cuerpo.pedido.faltante, 24900);
  // Desde $1,000 el envio es gratis.
  const gratis = await apartar(pedir, { entrega: 'envio', lineas: [{ producto_id: PRODUCTO, cantidad: 4 }], anticipo: 10000 });
  assert.equal(gratis.status, 201, JSON.stringify(gratis.cuerpo));
  assert.equal(gratis.cuerpo.pedido.envio, 0);
});

test('la lista trae apartados por vencimiento, envios por mandar y saldos a favor; la guia solo en envios', async () => {
  const { db, pedir } = tienda();
  const tarde = await apartar(pedir, { cliente: 'Tarde' });
  const pronto = await apartar(pedir, { cliente: 'Pronto' });
  db.prepare('update pedidos set vence_en = ? where id = ?').run('2020-01-01T00:00:00.000Z', pronto.id);
  const envio = await apartar(pedir, { entrega: 'envio', cliente: 'Envio' });
  // Pedido histórico de #269, ya cobrado completo: todavía puede cerrarse desde /caja.
  db.prepare('update pedidos set anticipo = 34900, saldo = 34900, liquidado_en = creado_en where id = ?').run(envio.id);
  const cancelado = await apartar(pedir, { cliente: 'Cancelado' });
  assert.equal((await pedir(`/api/pedidos/${cancelado.cuerpo.pedido.folio}/cancelar`, {})).status, 200);
  // El envio se cierra con una venta sin guia todavia.
  const v = await vender(pedir, { pedido_id: envio.id, anticipo: 34900, forma_pago: 'transferencia', efectivo: 0,
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: '00000000-0000-4000-8000-000000000099', cantidad: 1 }] });
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));

  const lista = (await pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos.map((p: any) => p.cliente);
  assert.deepEqual(lista.slice(0, 2), ['Pronto', 'Tarde']);   // apartados, por vence_en
  assert.deepEqual(lista.slice(2).sort(), ['Cancelado', 'Envio']);   // por enviar y saldo a favor vigente

  const folioEnvio = envio.cuerpo.pedido.folio;
  assert.equal((await pedir(`/api/pedidos/${folioEnvio}/guia`, { guia: '' }, 'PUT')).status, 400);
  const guia = await pedir(`/api/pedidos/${folioEnvio}/guia`, { guia: 'DHL 123' }, 'PUT');
  assert.equal(guia.status, 200);
  assert.equal(guia.cuerpo.pedido.guia, 'DHL 123');
  assert.equal((await pedir(`/api/pedidos/${tarde.cuerpo.pedido.folio}/guia`, { guia: 'x' }, 'PUT')).status, 409);
  const despues = (await pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos.map((p: any) => p.cliente);
  assert.deepEqual(despues.slice(2), ['Cancelado']);   // ya no esta por enviar y su saldo quedo en 0
});

test('venta con pedido cobra solo el resto; la pieza que no se llevo vuelve y el pedido pasa a vendido', async () => {
  const { db, pedir, esperar } = tienda();
  const b = pieza(db, 10000, 5);
  const ped = await apartar(pedir, { lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: b, cantidad: 1 }], anticipo: 10000 });
  assert.equal(stockDe(db, PRODUCTO), 49);
  assert.equal(stockDe(db, b), 4);

  // $250 con $100 de anticipo: faltan $150.
  const corto = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 14999 });
  assert.equal(corto.status, 400);
  assert.equal(stockDe(db, PRODUCTO), 49);   // nada cambio
  const sobrado = await vender(pedir, { pedido_id: ped.id, anticipo: 25001, efectivo: 25000 });
  assert.equal(sobrado.status, 400);
  const sinPedido = await vender(pedir, { anticipo: 10000, efectivo: 25000 });
  assert.equal(sinPedido.status, 400);

  const ok = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 20000 });
  await esperar();
  assert.equal(ok.status, 201, JSON.stringify(ok.cuerpo));
  assert.equal(ok.cuerpo.total, 25000);
  assert.equal(ok.cuerpo.anticipo, 10000);
  assert.equal(ok.cuerpo.saldo_pedido, 0);
  assert.equal(ok.cuerpo.cambio, 5000);   // 200 entregados por 150 a pagar
  assert.equal(stockDe(db, PRODUCTO), 49);   // devuelta por el apartado y descontada por la venta
  assert.equal(stockDe(db, b), 5);           // no se la llevo: vuelve a la venta
  const fila = db.prepare('select estado, saldo, venta_id from pedidos where id = ?').get(ped.id) as any;
  assert.deepEqual({ ...fila }, { estado: 'vendido', saldo: 0, venta_id: ok.id });
  const venta = db.prepare('select anticipo, pedido_id from ventas where id = ?').get(ok.id) as any;
  assert.deepEqual({ ...venta }, { anticipo: 10000, pedido_id: ped.id });

  // Mismo folio reintentado: misma respuesta, sin gastar saldo ni stock otra vez.
  const repetida = await pedir('/api/ventas', {
    id: ok.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 20000, caja: 'Caja 1',
    pedido_id: ped.id, anticipo: 10000,
  });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.cuerpo.duplicada, true);
  assert.equal(repetida.cuerpo.anticipo, 10000);
  assert.equal(stockDe(db, PRODUCTO), 49);

  // El ticket reimpreso trae el anticipo y el folio del pedido.
  const detalle = (await pedir(`/api/ventas/${ok.id}?imprimir=1`, undefined, 'GET')).cuerpo;
  assert.equal(detalle.anticipo, 10000);
  assert.equal(detalle.pedido_folio, ped.cuerpo.pedido.folio);
});

test('un pedido ya vendido no paga una segunda venta: sin saldo no hay anticipo', async () => {
  const { db, pedir } = tienda();
  const ped = await apartar(pedir);
  assert.equal((await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 15000 })).status, 201);
  const antes = stockDe(db, PRODUCTO);
  const otra = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 15000 });
  assert.equal(otra.status, 409);
  assert.match(otra.cuerpo.error, /saldo del pedido/);
  assert.equal(stockDe(db, PRODUCTO), antes);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 1);
  assert.equal((await vender(pedir, { pedido_id: crypto.randomUUID(), anticipo: 10000 })).status, 409);   // pedido inexistente
});

test('vencer devuelve la existencia una sola vez (cron dos veces) y deja el anticipo como saldo por un mes', async () => {
  const { db, env, pedir, esperar, ctx } = tienda();
  const ped = await apartar(pedir, { lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], anticipo: 10000 });
  const fresco = await apartar(pedir, { cliente: 'Fresco' });
  assert.equal(stockDe(db, PRODUCTO), 47);
  db.prepare('update pedidos set vence_en = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), ped.id);

  await worker.scheduled!({} as never, env, ctx as never);
  await esperar();
  assert.equal(stockDe(db, PRODUCTO), 49);   // 2 devueltas; el apartado fresco sigue reteniendo 1
  assert.equal(await vencerPedidos(env), 0);   // la segunda corrida no hace nada
  assert.equal(stockDe(db, PRODUCTO), 49);

  const fila = db.prepare('select estado, saldo, saldo_vence_en from pedidos where id = ?').get(ped.id) as any;
  assert.equal(fila.estado, 'vencido');
  assert.equal(fila.saldo, 10000);
  const dias = (Date.parse(fila.saldo_vence_en) - Date.now()) / 86_400_000;
  assert.ok(dias > 27 && dias < 32, `saldo vence en ${dias} dias`);
  assert.equal((db.prepare('select estado from pedidos where id = ?').get(fresco.id) as any).estado, 'apartado');
  assert.equal((await pedir(`/api/pedidos/${ped.cuerpo.pedido.folio}/cancelar`, {})).status, 409);   // ya no es apartado
});

test('cancelar devuelve el stock una vez y el saldo se usa en otra venta; vencido o de mas, 409', async () => {
  const { db, pedir } = tienda();
  const ped = await apartar(pedir, { anticipo: 20000 });
  const folio = ped.cuerpo.pedido.folio;
  assert.equal(stockDe(db, PRODUCTO), 49);
  const c = await pedir(`/api/pedidos/${folio}/cancelar`, {});
  assert.equal(c.status, 200);
  assert.equal(c.cuerpo.pedido.estado, 'cancelado');
  assert.equal(c.cuerpo.pedido.saldo, 20000);
  assert.equal(stockDe(db, PRODUCTO), 50);
  assert.equal((await pedir(`/api/pedidos/${folio}/cancelar`, {})).status, 409);
  assert.equal(stockDe(db, PRODUCTO), 50);   // no se devolvio dos veces
  assert.equal((await pedir('/api/pedidos/999/cancelar', {})).status, 404);

  // Mas que el saldo: 409. $250 con $200 de saldo: faltan $50.
  assert.equal((await vender(pedir, { pedido_id: ped.id, anticipo: 20001, efectivo: 25000 })).status, 409);
  const gasta = await vender(pedir, { pedido_id: ped.id, anticipo: 20000, efectivo: 5000 });
  assert.equal(gasta.status, 201, JSON.stringify(gasta.cuerpo));
  assert.equal(gasta.cuerpo.saldo_pedido, 0);
  assert.equal(stockDe(db, PRODUCTO), 49);   // solo la venta descuenta; el pedido cancelado no devuelve de nuevo
  assert.equal((db.prepare('select estado from pedidos where id = ?').get(ped.id) as any).estado, 'cancelado');

  // Saldo vencido.
  const viejo = await apartar(pedir);
  await pedir(`/api/pedidos/${viejo.cuerpo.pedido.folio}/cancelar`, {});
  db.prepare('update pedidos set saldo_vence_en = ? where id = ?').run('2020-01-01T00:00:00.000Z', viejo.id);
  const vencido = await vender(pedir, { pedido_id: viejo.id, anticipo: 10000, efectivo: 15000 });
  assert.equal(vencido.status, 409);
  assert.match(vencido.cuerpo.error, /cambió o venció/);
});

test('saldo parcial: lo que sobra del anticipo sigue a favor del cliente despues de la venta', async () => {
  const { pedir } = tienda();
  const ped = await apartar(pedir, { anticipo: 20000 });
  const v = await vender(pedir, { pedido_id: ped.id, anticipo: 5000, efectivo: 20000 });
  assert.equal(v.status, 201);
  assert.equal(v.cuerpo.saldo_pedido, 15000);
});

test('corte en efectivo: anticipo de $100 hoy + venta de $300 con anticipo pagada con $200 suma $300, en corte y en vista previa', async () => {
  const { db, pedir } = tienda();
  const b = pieza(db, 30000, 5);
  const ped = await apartar(pedir, { lineas: [{ producto_id: b, cantidad: 1 }], anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(ped.status, 201);
  const v = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, lineas: [{ producto_id: b, cantidad: 1 }], efectivo: 20000 });
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  // Otra caja no debe verlo.
  await apartar(pedir, { forma_pago: 'tarjeta', anticipo: 15000, caja: 'Caja 2' });

  const vista = (await pedir('/api/ventas', undefined, 'GET')).cuerpo;
  assert.equal(vista.por_forma_pago.find((f: any) => f.forma_pago === 'efectivo').total, 30000);
  assert.equal(vista.por_forma_pago.find((f: any) => f.forma_pago === 'tarjeta').total, 15000);
  const reportes = (await pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo;
  assert.equal(reportes.por_forma_pago.find((f: any) => f.forma_pago === 'efectivo').total, 30000);
  assert.equal(reportes.resumen.total, 30000);   // lo vendido sigue siendo el ticket completo

  const corte = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 80000, tarjeta_terminal: 0 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.efectivo_ventas, 30000);
  assert.equal(corte.cuerpo.efectivo_esperado, 80000);   // fondo $500 + $300
  assert.equal(corte.cuerpo.diferencia, 0);
  assert.equal(corte.cuerpo.tarjeta_sistema, 0);
  // El anticipo no se cuenta dos veces en el corte siguiente.
  const otro = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 80000, tarjeta_terminal: 0 });
  assert.equal(otro.cuerpo.efectivo_ventas, 0);
  // La tarjeta de la otra caja si cuenta en la suya.
  const caja2 = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 50000, tarjeta_terminal: 15000 });
  assert.equal(caja2.cuerpo.tarjeta_sistema, 15000);
  assert.equal(caja2.cuerpo.diferencia, 0);
});

test('un ticket que uso saldo de pedido no se cancela ni se devuelve por pieza en la caja', async () => {
  const { db, pedir } = tienda();
  const ped = await apartar(pedir);
  const v = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 15000 });
  assert.equal(v.status, 201);
  const antes = stockDe(db, PRODUCTO);

  const completo = await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'error', caja: 'Caja 1' });
  assert.equal(completo.status, 409);
  assert.match(completo.cuerpo.error, /usó saldo de un pedido/);
  const linea = (db.prepare('select id from venta_lineas where venta_id = ?').get(v.id) as { id: number }).id;
  const pieza1 = await pedir(`/api/ventas/${v.id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), motivo: 'error', caja: 'Caja 1' });
  assert.equal(pieza1.status, 409);
  assert.match(pieza1.cuerpo.error, /usó saldo de un pedido/);
  assert.equal(stockDe(db, PRODUCTO), antes);
  assert.equal((db.prepare('select cancelada from ventas where id = ?').get(v.id) as any).cancelada, 0);
  // Tampoco queda una solicitud de aprobacion para el dueno.
  const remota = await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'error', solicitar: true });
  assert.equal(remota.status, 409);
});

test('una pieza en un pedido no se puede descartar ni fusionar (en vez de reventar con la FK)', async () => {
  const { db, pedir } = tienda();
  const ped = await apartar(pedir);
  assert.equal(ped.status, 201);
  assert.equal((await pedir(`/api/borradores/${PRODUCTO}`, {}, 'DELETE')).status, 409);
  const otra = pieza(db, 5000, 1);
  assert.equal((await pedir(`/api/borradores/${PRODUCTO}/fusionar`, { destino_id: otra })).status, 409);
  assert.equal(stockDe(db, PRODUCTO), 49);
});

test('permisos: pedidos es de caja (cajero y computadora); un capturista no entra', () => {
  assert.deepEqual(permiso('/pedidos', 'GET'), ['cajero', 'computadora']);
  assert.deepEqual(permiso('/api/pedidos', 'POST'), ['cajero', 'computadora']);
  assert.deepEqual(permiso('/api/pedidos/17/cancelar', 'POST'), ['cajero', 'computadora']);
});

test('si otra caja gasta el saldo entre la lectura y el batch, el CHECK aborta la venta completa', async () => {
  const { db, env, pedir } = tienda();
  const ped = await apartar(pedir);
  const preparar = env.DB.prepare.bind(env.DB);
  (env.DB as any).prepare = (sql: string) => {
    const s = preparar(sql);
    if (sql.startsWith('select saldo, saldo_vence_en')) {
      const leer = s.first;
      s.first = async () => { const fila = await leer(); db.prepare('update pedidos set saldo = 0').run(); return fila; };
    }
    return s;
  };
  const v = await vender(pedir, { pedido_id: ped.id, anticipo: 10000, efectivo: 15000 });
  assert.equal(v.status, 409);
  assert.match(v.cuerpo.error, /cambió o venció/);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
  assert.equal(stockDe(db, PRODUCTO), 49);   // el apartado sigue reteniendo su pieza: el batch se deshizo
  assert.equal((db.prepare('select estado from pedidos where id = ?').get(ped.id) as any).estado, 'apartado');
});

// Pieza de FEP (Issue #298): propietario 'fep', como la pone la migracion 032 al marcarla.
function piezaFep(db: DatabaseSync, precio: number, stock: number) {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, ?, 'Bolsa FEP', ?, ?, 'listo', 'fotos/x.jpg', 'S41', '', '', 'fep')`)
    .run(id, `ED-${String(++consecutivo).padStart(6, '0')}`, precio, stock);
  return id;
}

test('catalogo de caja entrega el propietario de piezas FEP y de la tienda', async () => {
  const { db, pedir } = tienda();
  try {
    const fep = piezaFep(db, 25000, 5);
    const r = await pedir('/api/catalogo', undefined, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.find((p: any) => p.id === fep)?.propietario, 'fep');
    assert.equal(r.cuerpo.find((p: any) => p.id === PRODUCTO)?.propietario, 'dolaron');
  } finally { db.close(); }
});

test('anticipo y Dolarones en un mismo ticket: la fila dolarones del reporte no cuenta el anticipo y las formas suman el resumen', async () => {
  const { db, pedir } = tienda();
  // Un socio con $20 de Dolarones: una compra de $250 en efectivo le da $20 (8%) al dia siguiente.
  const socio = (await pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990001',
    acepta_bases: true, declara_mayor_edad: true })).cuerpo;
  await pedir('/api/portal/llegada', { cliente_id: socio.id });
  assert.equal((await pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: socio.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1' })).status, 201);
  db.prepare("update dolarones_lotes set disponible_desde = '2026-01-01' where origen = 'compra'").run();

  // Pedido de $250 con $100 de anticipo en tarjeta. El ticket de $250 se paga con $20 de Dolarones,
  // $100 del anticipo y $130 en efectivo.
  const ped = await apartar(pedir, { forma_pago: 'tarjeta', anticipo: 10000 });
  assert.equal(ped.status, 201);
  const v = await pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: socio.id, codigo_socio: await codigoPrueba(db, socio.id),
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 13000, caja: 'Caja 1',
    dolarones: 2000, pedido_id: ped.id, anticipo: 10000 });
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  assert.equal(v.cuerpo.cambio, 0);

  const r = (await pedir('/api/reportes?dias=7', undefined, 'GET')).cuerpo;
  const formas = Object.fromEntries(r.por_forma_pago.map((f: any) => [f.forma_pago, f.total]));
  // Ventas: $250 de la compra previa + $250 de este ticket.
  assert.equal(r.resumen.total, 50000);
  assert.equal(formas.efectivo, 38000);   // $250 de la compra previa + $130 de este ticket
  assert.equal(formas.tarjeta, 10000);    // el anticipo entro el dia que se aparto, una sola vez
  assert.equal(formas.dolarones, 2000);   // solo los Dolarones: sin los $100 de anticipo
  assert.equal(Object.values(formas).reduce((suma: number, n) => suma + n, 0), r.resumen.total);
  assert.equal(r.por_forma_pago.find((f: any) => f.forma_pago === 'dolarones').tickets, 1);
});

test('corte FEP: el anticipo de un pedido de la tienda entra al cajon una sola vez y no se le debe a FEP', async () => {
  const { db, pedir } = tienda();
  const fep = piezaFep(db, 30000, 5);
  const b = pieza(db, 25000, 5);
  // Pedido de la tienda con $100 de anticipo en efectivo.
  assert.equal((await apartar(pedir, { lineas: [{ producto_id: b, cantidad: 1 }], anticipo: 10000, forma_pago: 'efectivo' })).status, 201);
  // Dos piezas de FEP cobradas en efectivo, sin pedido.
  assert.equal((await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: fep, cantidad: 2 }],
    forma_pago: 'efectivo', efectivo: 60000, caja: 'Caja 1' })).status, 201);

  const corte = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 120000, tarjeta_terminal: 0 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.efectivo_ventas, 70000);      // $100 del anticipo + $600 de FEP
  assert.equal(corte.cuerpo.fep_por_pagar, 60000);        // solo lo cobrado de sus piezas
  assert.equal(corte.cuerpo.efectivo_esperado, 120000);   // fondo $500 + $700
  assert.equal(corte.cuerpo.diferencia, 0);
});

// Decision de Isaac (#269): las piezas de FEP no entran a un pedido; FEP no acepta anticipos en tienda.
test('un pedido con pieza de FEP se rechaza: no se crea, no baja existencia y no entra al corte', async () => {
  const { db, pedir } = tienda();
  const fep = piezaFep(db, 25000, 5);
  const r = await apartar(pedir, { lineas: [{ producto_id: fep, cantidad: 1 }], anticipo: 10000, forma_pago: 'efectivo' });
  assert.equal(r.status, 400);
  assert.equal(r.cuerpo.error, 'Las piezas de FEP no se pueden apartar: no aceptamos anticipos de FEP en tienda.');
  assert.equal(stockDe(db, fep), 5);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select count(*) as n from pedido_lineas').get() as { n: number }).n, 0);
});

test('una pieza de tienda sigue apartandose aunque el pedido venga con una pieza de FEP en otra linea', async () => {
  const { db, pedir } = tienda();
  const fep = piezaFep(db, 25000, 5);
  const b = pieza(db, 25000, 5);
  const mezcla = await apartar(pedir, { lineas: [{ producto_id: b, cantidad: 1 }, { producto_id: fep, cantidad: 1 }], anticipo: 10000 });
  assert.equal(mezcla.status, 400);
  assert.equal(stockDe(db, b), 5);
  const solo = await apartar(pedir, { lineas: [{ producto_id: b, cantidad: 1 }], anticipo: 10000 });
  assert.equal(solo.status, 201, JSON.stringify(solo.cuerpo));
  assert.equal(stockDe(db, b), 4);
});

test('una prenda de $50 se aparta con $8: D1 guarda el dinero real y el corte lo cuenta', async () => {
  const { db, pedir } = tienda();
  const prenda = pieza(db, 5000, 1);
  const lineas = [{ producto_id: prenda, cantidad: 1 }];
  assert.equal((await apartar(pedir, { lineas, anticipo: 799 })).status, 400);
  const r = await apartar(pedir, { lineas, anticipo: 800, forma_pago: 'efectivo' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.pedido.anticipo, 800);
  assert.equal(r.cuerpo.pedido.saldo, 800);
  assert.equal(stockDe(db, prenda), 0);
  const c = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 50800 });
  assert.equal(c.cuerpo.efectivo_ventas, 800);
  assert.equal(c.cuerpo.diferencia, 0);
});

test('agregar conserva precios pactados, recalcula envío gratis y renueva 7 días sin otro cobro', async () => {
  const { db, pedir } = tienda();
  const r = await paquete(pedir);
  const folio = r.cuerpo.pedido.folio;
  db.prepare('update pedidos set vence_en = ? where id = ?').run(new Date(Date.now() + 86400000).toISOString(), r.id);
  db.prepare('update productos set precio = 99900 where id = ?').run(PRODUCTO);
  const agregado = await agregarAPaquete(pedir, folio, PRODUCTO, { cantidad: 3 });
  assert.equal(agregado.status, 200, JSON.stringify(agregado.cuerpo));
  const p = (await pedir(`/api/pedidos/${folio}`, undefined, 'GET')).cuerpo.pedido;
  assert.equal(p.subtotal, 100000); // cuatro unidades al precio pactado, no al nuevo del catálogo
  assert.equal(p.envio, 0);
  assert.equal(p.anticipo, 10000);
  assert.equal(p.saldo, 10000);
  assert.equal(p.faltante, 90000);
  assert.equal(p.lineas[0].cantidad, 4);
  assert.ok(Date.parse(p.vence_en) > Date.now() + 6.9 * 86400000);
  assert.equal(stockDe(db, PRODUCTO), 46);
  assert.equal((db.prepare("select sum(importe) as n from pedido_movimientos").get() as any).n, 0);
});

test('dos cajas agregan la misma pieza única con lecturas previas: solo un batch cambia stock y líneas', async () => {
  const { db, env, pedir } = tienda();
  const a = await paquete(pedir, { caja: 'Caja 1' });
  const b = await paquete(pedir, { caja: 'Caja 2' });
  const ultima = pieza(db, 10000, 1);
  juntarDosBatches(env);
  const rs = await Promise.all([
    agregarAPaquete(pedir, a.cuerpo.pedido.folio, ultima),
    agregarAPaquete(pedir, b.cuerpo.pedido.folio, ultima),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal(stockDe(db, ultima), 0);
  assert.equal(stockDe(db, PRODUCTO), 48);
  assert.equal((db.prepare('select sum(cantidad) as n from pedido_lineas where producto_id = ?').get(ultima) as any).n, 1);
  assert.equal((db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 1);
  assert.equal((db.prepare('select sum(saldo) as n from pedidos').get() as any).n, 20000);
});

test('pieza y abono rechazan tienda, FEP, cantidad inválida y paquete cerrado sin efectos parciales', async () => {
  const { db, pedir } = tienda();
  const local = await apartar(pedir);
  assert.equal((await agregarAPaquete(pedir, local.cuerpo.pedido.folio, PRODUCTO)).status, 409);
  assert.equal((await abonar(pedir, local.cuerpo.pedido.folio, 100)).status, 409);
  const p = await paquete(pedir);
  const folio = p.cuerpo.pedido.folio;
  const fep = piezaFep(db, 25000, 1);
  assert.equal((await agregarAPaquete(pedir, folio, fep)).status, 400);
  assert.equal((await agregarAPaquete(pedir, folio, PRODUCTO, { cantidad: 0 })).status, 400);
  assert.equal((await abonar(pedir, folio, 1.5)).status, 400);
  assert.equal((await abonar(pedir, folio, 0)).status, 400);
  assert.equal((await abonar(pedir, folio, 100, { caja: '' })).status, 400);
  assert.equal((await abonar(pedir, folio, 24901)).status, 400);
  assert.equal((await pedir(`/api/pedidos/${folio}/guia`, { guia: 'sin pagar' }, 'PUT')).status, 409);
  await pedir(`/api/pedidos/${folio}/cancelar`, {});
  assert.equal((await agregarAPaquete(pedir, folio, PRODUCTO)).status, 409);
  assert.equal((await abonar(pedir, folio, 100)).status, 409);
  assert.equal((db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  assert.equal(stockDe(db, PRODUCTO), 49);
});

test('respuesta perdida y reintentos concurrentes conservan el resultado original de pieza y abono', async () => {
  const { db, env, pedir } = tienda();
  const p = await paquete(pedir);
  const folio = p.cuerpo.pedido.folio;
  const piezaId = crypto.randomUUID();
  const a = await agregarAPaquete(pedir, folio, PRODUCTO, { id: piezaId });
  assert.equal(a.status, 200);
  const b = await abonar(pedir, folio, 10000);
  assert.equal(b.status, 200);
  assert.deepEqual((await agregarAPaquete(pedir, folio, PRODUCTO, { id: piezaId })).cuerpo, a.cuerpo);
  assert.equal((await agregarAPaquete(pedir, folio, PRODUCTO, { id: piezaId, cantidad: 2 })).status, 409);
  juntarDosBatches(env);
  const id = crypto.randomUUID();
  const [uno, dos] = await Promise.all([abonar(pedir, folio, 5000, { id }), abonar(pedir, folio, 5000, { id })]);
  assert.equal(uno.status, 200);
  assert.equal(dos.status, 200);
  assert.deepEqual(uno.cuerpo, dos.cuerpo);
  assert.equal((db.prepare('select saldo from pedidos where id = ?').get(p.id) as any).saldo, 25000);
  assert.equal(stockDe(db, PRODUCTO), 48);
  assert.equal((db.prepare("select sum(importe) as n from pedido_movimientos where tipo = 'abono'").get() as any).n, 15000);
});

test('último abono emite un solo ticket sin descontar stock ni cobrar otra vez; el viernes queda fijo y ya no vence', async () => {
  const { db, env, pedir } = tienda();
  const p = await paquete(pedir, { forma_pago: 'efectivo' });
  const folio = p.cuerpo.pedido.folio;
  juntarDosBatches(env);
  const rs = await Promise.all([abonar(pedir, folio, 24900), abonar(pedir, folio, 24900, { caja: 'Caja 2' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const actual = (await pedir(`/api/pedidos/${folio}`, undefined, 'GET')).cuerpo.pedido;
  assert.equal(actual.estado, 'vendido');
  assert.equal(actual.saldo, 0);
  assert.equal(actual.faltante, 0);
  assert.equal(actual.viernes_envio, viernesDeEnvio(actual.liquidado_en));
  assert.equal(stockDe(db, PRODUCTO), 49);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as any).n, 1);
  const ticket = (await pedir(`/api/ventas/${actual.venta_id}?imprimir=1`, undefined, 'GET')).cuerpo;
  assert.equal(ticket.total, 34900);
  assert.equal(ticket.anticipo, 34900);
  assert.equal(ticket.lineas.reduce((s: number, l: any) => s + l.precio * l.cantidad, 0), ticket.total);
  assert.equal(await vencerPedidos(env, new Date(Date.now() + 90 * 86400000)), 0);
  assert.equal(stockDe(db, PRODUCTO), 49);
  assert.equal((await agregarAPaquete(pedir, folio, PRODUCTO)).status, 409);
  assert.equal((await abonar(pedir, folio, 100)).status, 409);
  assert.equal((await pedir(`/api/pedidos/${folio}/cancelar`, {})).status, 409);
  assert.equal((await pedir(`/api/pedidos/${folio}/guia`, { guia: 'DHL 434' }, 'PUT')).status, 200);
});

test('cada abono entra en su fecha, forma y caja, una vez; liquidar no duplica ingresos en reportes ni cortes', async () => {
  const { db, pedir } = tienda();
  const p = await paquete(pedir, { forma_pago: 'efectivo', caja: 'Caja 1' });
  const folio = p.cuerpo.pedido.folio;
  db.prepare("update pedidos set creado_en = '2020-01-01T12:00:00.000Z' where id = ?").run(p.id);
  const primero = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 60000 });
  assert.equal(primero.cuerpo.efectivo_ventas, 10000);
  const a = await abonar(pedir, folio, 10000, { forma_pago: 'tarjeta', caja: 'Caja 2' });
  assert.equal(a.status, 200);
  const ultimoId = crypto.randomUUID();
  const transferencia = { id: ultimoId, forma_pago: 'transferencia', ...datosTransferencia(14900) };
  assert.equal((await abonar(pedir, folio, 14900, transferencia)).status, 200);
  assert.equal((await abonar(pedir, folio, 14900, transferencia)).status, 200);
  const vista = (await pedir('/api/ventas', undefined, 'GET')).cuerpo;
  const formas = Object.fromEntries(vista.por_forma_pago.map((f: any) => [f.forma_pago, f.total]));
  assert.equal(formas.efectivo ?? 0, 0); // anticipo de otro día
  assert.equal(formas.tarjeta, 10000);
  assert.equal(formas.transferencia, 14900);
  const reporte = (await pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo;
  assert.equal(reporte.resumen.total, 34900);
  assert.equal(reporte.por_forma_pago.reduce((s: number, f: any) => s + f.total, 0), 24900);
  const caja1 = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 50000 });
  assert.equal(caja1.cuerpo.efectivo_ventas, 0);
  assert.equal(caja1.cuerpo.transferencias, 14900);
  const caja2 = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 50000, tarjeta_terminal: 10000 });
  assert.equal(caja2.cuerpo.tarjeta_sistema, 10000);
  assert.equal(caja2.cuerpo.diferencia, 0);
  const otro = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 50000, tarjeta_terminal: 0 });
  assert.equal(otro.cuerpo.tarjeta_sistema, 0);
});

test('cancelar o vencer conserva anticipo + abonos y devuelve todas las piezas una sola vez', async () => {
  for (const cancelar of [true, false]) {
    const { db, env, pedir } = tienda();
    const p = await paquete(pedir);
    const folio = p.cuerpo.pedido.folio;
    await agregarAPaquete(pedir, folio, PRODUCTO);
    await abonar(pedir, folio, 10000);
    if (cancelar) await pedir(`/api/pedidos/${folio}/cancelar`, {});
    else {
      db.prepare("update pedidos set vence_en = '2020-01-01' where id = ?").run(p.id);
      assert.equal(await vencerPedidos(env), 1);
    }
    assert.equal(await vencerPedidos(env), 0);
    assert.equal(stockDe(db, PRODUCTO), 50);
    const actual = (await pedir(`/api/pedidos/${folio}`, undefined, 'GET')).cuerpo.pedido;
    assert.equal(actual.saldo, 20000);
    assert.equal((await vender(pedir, { pedido_id: p.id, anticipo: 20000, efectivo: 5000 })).status, 201);
    assert.equal(stockDe(db, PRODUCTO), 49);
  }
});

test('el cron revalida el plazo en SQL: un abono entre selección y batch salva el paquete', async () => {
  const { db, env, pedir } = tienda();
  const p = await paquete(pedir);
  const folio = p.cuerpo.pedido.folio;
  db.prepare('update pedidos set vence_en = ? where id = ?').run(new Date(Date.now() + 3600000).toISOString(), p.id);
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    env.DB.batch = batch;
    assert.equal((await abonar(pedir, folio, 100)).status, 200);
    return batch(sentencias);
  }) as typeof env.DB.batch;
  assert.equal(await vencerPedidos(env, new Date(Date.now() + 2 * 3600000)), 0);
  assert.equal(stockDe(db, PRODUCTO), 49);
  assert.equal((db.prepare('select estado, saldo from pedidos where id = ?').get(p.id) as any).saldo, 10100);
});

test('cancelación intercalada antes del batch impide tanto agregar como abonar, sin tocar stock o dinero', async () => {
  for (const tipo of ['pieza', 'abono']) {
    const { db, env, pedir } = tienda();
    const p = await paquete(pedir);
    const folio = p.cuerpo.pedido.folio;
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
      env.DB.batch = batch;
      assert.equal((await pedir(`/api/pedidos/${folio}/cancelar`, {})).status, 200);
      return batch(sentencias);
    }) as typeof env.DB.batch;
    const r = tipo === 'pieza' ? await agregarAPaquete(pedir, folio, PRODUCTO) : await abonar(pedir, folio, 100);
    assert.equal(r.status, 409);
    assert.equal(stockDe(db, PRODUCTO), 50);
    assert.equal((db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
    assert.equal((db.prepare('select saldo from pedidos where id = ?').get(p.id) as any).saldo, 10000);
  }
});

test('un paquete abierto no puede pagar otro ticket, ni siquiera con anticipo cero', async () => {
  const { db, pedir } = tienda();
  const p = await paquete(pedir);
  for (const anticipo of [0, 10000]) {
    const r = await vender(pedir, { pedido_id: p.id, anticipo, efectivo: 25000 });
    assert.equal(r.status, 409);
  }
  assert.equal(stockDe(db, PRODUCTO), 49);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as any).n, 0);
});

test('la liquidación conserva la emisión vigente de vales y sus reintentos no generan crédito doble', async () => {
  const { db, env, pedir } = tienda();
  env.VALES_ABIERTOS = 'si';
  const p = await paquete(pedir);
  const folio = p.cuerpo.pedido.folio;
  const id = crypto.randomUUID();
  assert.equal((await abonar(pedir, folio, 24900, { id })).status, 200);
  assert.equal((await abonar(pedir, folio, 24900, { id })).status, 200);
  const ticket = (await pedir(`/api/ventas/${id}?imprimir=1`, undefined, 'GET')).cuerpo;
  assert.equal(ticket.vale_emitido.importe, 1500); // 5 D por cada $100 completos del total de $349
  assert.equal((db.prepare('select count(*) as n from vales_dolarones').get() as any).n, 1);
  assert.equal(stockDe(db, PRODUCTO), 49);
});

test('al alcanzar envío gratis, el excedente ya cobrado queda como saldo a favor y no desaparece', async () => {
  const { db, pedir } = tienda();
  const a = pieza(db, 99900, 1);
  const b = pieza(db, 100, 1);
  const p = await paquete(pedir, { lineas: [{ producto_id: a, cantidad: 1 }] });
  const folio = p.cuerpo.pedido.folio;
  assert.equal((await abonar(pedir, folio, 95000)).status, 200); // pagado $1,050 de $1,098
  assert.equal((await agregarAPaquete(pedir, folio, b)).status, 200); // total nuevo $1,000, envío gratis
  const actual = (await pedir(`/api/pedidos/${folio}`, undefined, 'GET')).cuerpo.pedido;
  assert.equal(actual.estado, 'vendido');
  assert.equal(actual.envio, 0);
  assert.equal(actual.saldo, 5000);
  assert.equal(actual.faltante, 0);
  assert.equal(stockDe(db, a), 0);
  assert.equal(stockDe(db, b), 0);
  const ticket = (await pedir(`/api/ventas/${actual.venta_id}`, undefined, 'GET')).cuerpo;
  assert.equal(ticket.total, 100000);
  assert.equal(ticket.anticipo, 100000);
  assert.equal(ticket.caja, 'Caja 1');
});

test('cero filas no aborta batch; el CHECK sí revierte cuando desaparece la pieza tras la lectura', async () => {
  const { db, env, pedir } = tienda();
  const cero = await env.DB.batch([
    env.DB.prepare("update productos set stock = 0 where id = 'ausente'"),
    env.DB.prepare("insert into config (clave, valor) values ('prueba_434', 'confirmado')"),
  ]);
  assert.equal(cero[0].meta.changes, 0);
  assert.equal((db.prepare("select valor from config where clave = 'prueba_434'").get() as any).valor, 'confirmado');
  const p = await paquete(pedir);
  const ultima = pieza(db, 10000, 1);
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    env.DB.batch = batch;
    db.prepare('delete from productos where id = ?').run(ultima);
    return batch(sentencias);
  }) as typeof env.DB.batch;
  assert.equal((await agregarAPaquete(pedir, p.cuerpo.pedido.folio, ultima)).status, 409);
  assert.equal((db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  assert.equal((db.prepare('select cantidad from pedido_lineas where pedido_id = ?').get(p.id) as any).cantidad, 1);
  assert.equal((db.prepare('select revision from pedidos where id = ?').get(p.id) as any).revision, 0);
  assert.equal(stockDe(db, PRODUCTO), 49);
});

test('056: base vacía completa, con todas las migraciones en una transacción y FK activas', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('pragma foreign_keys = on; begin');
    for (const archivo of ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()])
      db.exec(readFileSync(archivo, 'utf8'));
    db.exec('commit');
    assert.equal(db.prepare('pragma foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    assert.deepEqual(db.prepare('select * from pedidos').all(), []);
    assert.deepEqual(db.prepare('select * from pedido_movimientos').all(), []);
    assert.deepEqual(db.prepare('pragma table_info(pedidos)').all().slice(-2).map((c) => c.name), ['revision', 'liquidado_en']);
  } finally { db.close(); }
});

test('056: conserva todos los valores históricos, FK, índices y triggers; acepta $8 y rechaza huérfanos', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('pragma foreign_keys = on');
    for (const archivo of ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f) && Number(f.slice(10, 13)) < 56).sort()])
      db.exec(readFileSync(archivo, 'utf8'));
    db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
      values (?, 'ED-000001', 'Prenda', 25000, 48, 'S40', '', '')`).run(PRODUCTO);
    const ventaId = crypto.randomUUID();
    db.prepare(`insert into ventas (id, total, forma_pago, creado_en, registrado_en, anticipo)
      values (?, 34900, 'transferencia', '2026-10-23T12:00:00.000Z', '2026-10-23T12:00:00.000Z', 34900)`).run(ventaId);
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    const filas = [
      ['tienda', 0, 'apartado', 10000, 10000, null],
      ['envio', 9900, 'apartado', 34900, 34900, null],
      ['envio', 9900, 'vendido', 34900, 0, ventaId],
      ['tienda', 0, 'cancelado', 10000, 10000, null],
    ];
    filas.forEach((fila, i) => {
      db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, estado, anticipo, saldo,
        venta_id, vendedora, forma_pago, caja, corte_id, vence_en, saldo_vence_en, creado_en, actualizado_en)
        values (?, ?, 'Ana', '4441234567', ?, ?, ?, ?, ?, ?, 'caja@prueba.mx', 'transferencia', 'Caja 1',
          'corte-anterior', '2026-10-29T12:00:00.000Z', '2026-11-29T12:00:00.000Z',
          '2026-10-22T19:00:00.000Z', '2026-10-23T12:00:00.000Z')`).run(ids[i], i + 1, ...fila as never[]);
      db.prepare('insert into pedido_lineas (pedido_id, producto_id, cantidad) values (?, ?, 1)').run(ids[i], PRODUCTO);
    });
    db.prepare('update ventas set pedido_id = ? where id = ?').run(ids[2], ventaId);
    db.prepare(`insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad)
      values (?, ?, 'ED-000001', 'Prenda', 25000, 1)`).run(ventaId, PRODUCTO);
    // pedido_movimientos nace en 056. Los movimientos históricos existentes son los
    // de vales, ligados al ticket: también deben sobrevivir sin reconstruir ventas.
    db.prepare(`insert into vales_dolarones (id, venta_id, codigo, importe, restante, disponible_desde, vence_en, creado_en)
      values ('vale-anterior', ?, 'ED-ANTERIOR', 1000, 1000, '2026-10-24', '2026-11-24', '2026-10-23')`).run(ventaId);
    db.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
      values ('vale-anterior', ?, 'emision', 1000, 'caja@prueba.mx', '2026-10-23')`).run(ventaId);
    db.prepare("update pedidos set guia = 'Guía histórica áéíóú' where id = ?").run(ids[2]);
    assert.throws(() => db.prepare('update pedidos set anticipo = 800 where id = ?').run(ids[0]), /CHECK constraint/);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    const tablas = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all();
    const historico = tablas.map(({ name }) => ({
      nombre: String(name),
      columnas: db.prepare(`pragma table_info("${name}")`).all(),
      filas: db.prepare(`select * from "${name}" order by rowid`).all(),
      fk: db.prepare(`pragma foreign_key_list("${name}")`).all(),
    }));
    const objetos = () => db.prepare(`select type, name, tbl_name, sql from sqlite_master
      where type in ('index', 'trigger') order by name`).all().map((o) => ({
      ...o, sql: typeof o.sql === 'string' ? o.sql.replace(/\s+/g, ' ').trim() : o.sql,
    }));
    const objetosAntes = objetos();
    const referencias = () => db.prepare(`select m.name as tabla, f."from" as columna, f."to" as destino,
      f.on_update, f.on_delete from sqlite_master m, pragma_foreign_key_list(m.name) f
      where m.type = 'table' and f."table" = 'pedidos' order by m.name, f.id`).all();
    const referenciasAntes = referencias();
    assert.deepEqual(referenciasAntes.map((f) => f.tabla), ['pedido_lineas', 'ventas']);
    const antes = db.prepare('select * from pedidos order by folio').all();
    // La vista de 054 lee pedidos y pedido_lineas: 056 corre DESPUÉS de ella en producción.
    const vista = () => String(db.prepare("select sql from sqlite_master where type = 'view' and name = 'movimientos_existencia'").get()?.sql ?? '')
      .replace(/\s+/g, ' ').trim();
    const vistaAntes = vista();
    assert.ok(vistaAntes);
    const movimientosAntes = db.prepare('select * from movimientos_existencia order by referencia, tipo').all();
    db.exec('begin');
    db.exec(readFileSync('migracion-056-apartados.sql', 'utf8'));
    db.exec('commit');
    assert.deepEqual(vista(), vistaAntes);
    assert.deepEqual(db.prepare('select * from movimientos_existencia order by referencia, tipo').all(), movimientosAntes);
    // Un segundo pase (ya corrida, p. ej. como 048 en sandbox) falla en su primera sentencia y no toca nada.
    const pedidosAplicados = db.prepare('select * from pedidos order by folio').all();
    const lineasAplicadas = db.prepare('select * from pedido_lineas order by rowid').all();
    db.exec('begin');
    assert.throws(() => db.exec(readFileSync('migracion-056-apartados.sql', 'utf8')), /pedido_movimientos already exists/);
    db.exec('rollback');
    assert.deepEqual(db.prepare('select * from pedidos order by folio').all(), pedidosAplicados);
    assert.deepEqual(db.prepare('select * from pedido_lineas order by rowid').all(), lineasAplicadas);
    // Comparar TODAS las columnas originales de TODAS las tablas, no solo conteos.
    for (const { nombre, columnas, filas, fk } of historico) {
      const nombres = columnas.map((c) => `"${c.name}"`).join(', ');
      assert.deepEqual(db.prepare(`select ${nombres} from "${nombre}" order by rowid`).all(), filas, nombre);
      assert.deepEqual(db.prepare(`pragma table_info("${nombre}")`).all().slice(0, columnas.length), columnas, nombre);
      assert.deepEqual(db.prepare(`pragma foreign_key_list("${nombre}")`).all(), fk, nombre);
    }
    const nombresAntes = new Set(objetosAntes.map((o) => o.name));
    assert.deepEqual(objetos().filter((o) => nombresAntes.has(o.name)), objetosAntes);
    assert.deepEqual(referencias().filter((f) => f.tabla !== 'pedido_movimientos'), referenciasAntes);
    assert.deepEqual(referencias().map((f) => f.tabla), ['pedido_lineas', 'pedido_movimientos', 'ventas']);
    assert.equal(db.prepare('pragma foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare("select name from sqlite_master where name like '%_copia' or name = 'pedidos_nueva'").all(), []);
    const despues = db.prepare('select * from pedidos order by folio').all();
    assert.deepEqual(despues.map(({ revision, liquidado_en, ...p }) => p), antes.map((p) => ({ ...p })));
    assert.equal(despues[0].liquidado_en, null);
    assert.equal(despues[1].liquidado_en, '2026-10-22T19:00:00.000Z');
    assert.equal(despues[2].liquidado_en, '2026-10-23T12:00:00.000Z');
    assert.equal((db.prepare('select count(*) as n from pedido_lineas where precio = 25000').get() as any).n, 4);
    assert.equal(stockDe(db, PRODUCTO), 48);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    assert.throws(() => db.prepare('update pedidos set saldo = -1 where id = ?').run(ids[0]), /saldo de pedido invalido/);
    assert.equal((db.prepare('select pedido_id from ventas where id = ?').get(ventaId) as any).pedido_id, ids[2]);
    // La regla porcentual se valida en la API (casos de $38/$8 arriba); SQL conserva
    // el dinero recibido sin mínimo fijo, pero sigue prohibiendo importes negativos.
    db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en,
      anticipo, forma_pago, saldo, saldo_vence_en, creado_en, actualizado_en)
      select 'pedido-ocho', 5, cliente, telefono, entrega, vendedora, estado, vence_en,
      800, forma_pago, 800, saldo_vence_en, creado_en, actualizado_en from pedidos where id = ?`).run(ids[0]);
    assert.equal(db.prepare("select anticipo from pedidos where id = 'pedido-ocho'").get()!.anticipo, 800);
    assert.throws(() => db.prepare("update pedidos set anticipo = -1 where id = 'pedido-ocho'").run(), /CHECK constraint/);
    assert.throws(() => db.prepare('update pedidos set folio = 1 where id = ?').run(ids[1]), /UNIQUE constraint/);
    assert.throws(() => db.prepare("update pedidos set venta_id = 'ausente' where id = ?").run(ids[0]), /FOREIGN KEY constraint/);
    assert.throws(() => db.prepare("update pedido_lineas set pedido_id = 'ausente' where pedido_id = ?").run(ids[0]), /FOREIGN KEY constraint/);
    assert.throws(() => db.prepare("update ventas set pedido_id = 'ausente' where id = ?").run(ventaId), /FOREIGN KEY constraint/);
    db.prepare(`insert into pedido_movimientos (id, pedido_id, tipo, solicitud, importe, forma_pago, caja, autor, creado_en, respuesta)
      values ('abono-ocho', 'pedido-ocho', 'abono', '{}', 100, 'efectivo', 'Caja 1', 'prueba', '2026-10-22', '{}')`).run();
    assert.throws(() => db.prepare("update pedido_movimientos set pedido_id = 'ausente' where id = 'abono-ocho'").run(), /FOREIGN KEY constraint/);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
  } finally { db.close(); }
});
