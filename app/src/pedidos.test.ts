// node --test src/pedidos.test.ts
// Pedidos por WhatsApp, fase 1 (Issue #269) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { tienda, PRODUCTO, codigoPrueba, datosTransferencia } from './prueba-d1.ts';
import { permiso } from './cuentas.ts';
import { PUBLICABLE } from './mercadolibre.ts';
import { vencerPedidos, telefonoDe, apartarPortal, cancelarDeSocio, HORAS_PORTAL, APARTADOS_PORTAL } from './pedidos.ts';
import { viernesDeEnvio } from '../public/venta.js';
import worker from './worker.ts';

// PRODUCTO vale $250 y hay 50. Los demas se crean aqui.
let consecutivo = 100;
function pieza(db: DatabaseSync, precio: number, stock: number, nombre = `Pieza ${consecutivo + 1}`) {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
              values (?, ?, ?, ?, ?, 'listo', 'fotos/x.jpg', 'S40', '', '')`)
    .run(id, `ED-${String(++consecutivo).padStart(6, '0')}`, nombre, precio, stock);
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

test('reglas del pedido: $100 de anticipo, tienda y envío, tarifa, teléfono, etiquetas y caja para todo cobro', async () => {
  const { db, pedir } = tienda();
  assert.equal(telefonoDe('+52 (444) 123-4567'), '4441234567');
  assert.equal(telefonoDe('123'), null);

  assert.equal((await apartar(pedir, { anticipo: 9999 })).status, 400);
  assert.equal((await apartar(pedir, { anticipo: 10000 })).status, 201);          // $250: $100 fijos, no 15 %
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

test('apartado de $100 fijos (#662): $150 pide $100 y $60 se paga completo, recogiendo o con envío', async () => {
  const { db, pedir } = tienda();
  const caro = [{ producto_id: pieza(db, 15000, 5), cantidad: 1 }];
  const barato = [{ producto_id: pieza(db, 6000, 5), cantidad: 1 }];
  // Recoger una pieza de $150: $50 no alcanza, $100 sí.
  assert.equal((await apartar(pedir, { lineas: caro, anticipo: 5000 })).status, 400);
  assert.equal((await apartar(pedir, { lineas: caro, anticipo: 9999 })).status, 400);
  assert.equal((await apartar(pedir, { lineas: caro, anticipo: 10000 })).cuerpo.pedido.anticipo, 10000);
  // Recoger una de $60: el anticipo es el total.
  assert.equal((await apartar(pedir, { lineas: barato, anticipo: 5999 })).status, 400);
  assert.equal((await apartar(pedir, { lineas: barato, anticipo: 6000 })).cuerpo.pedido.anticipo, 6000);
  // Envío de $150 + $99: abre con $100 exactos.
  assert.equal((await apartar(pedir, { lineas: caro, entrega: 'envio', anticipo: 5000 })).status, 400);
  assert.equal((await apartar(pedir, { lineas: caro, entrega: 'envio', anticipo: 12000 })).status, 400);
  const envioCaro = await apartar(pedir, { lineas: caro, entrega: 'envio', anticipo: 10000 });
  assert.equal(envioCaro.cuerpo.pedido.anticipo, 10000);
  assert.equal(envioCaro.cuerpo.pedido.faltante, 14900);
  // Envío de $60 + $99: el anticipo mínimo es el total de la pieza; $100 también abre el paquete.
  assert.equal((await apartar(pedir, { lineas: barato, entrega: 'envio', anticipo: 5999 })).status, 400);
  const envioBarato = await apartar(pedir, { lineas: barato, entrega: 'envio', anticipo: 6000 });
  assert.equal(envioBarato.status, 201, JSON.stringify(envioBarato.cuerpo));
  assert.equal(envioBarato.cuerpo.pedido.faltante, 9900);
  assert.equal((await apartar(pedir, { lineas: barato, entrega: 'envio', anticipo: 10000 })).status, 201);
});

test('una prenda de $50 se aparta con sus $50 completos: D1 guarda el dinero real y el corte lo cuenta', async () => {
  const { db, pedir } = tienda();
  const prenda = pieza(db, 5000, 1);
  const lineas = [{ producto_id: prenda, cantidad: 1 }];
  assert.equal((await apartar(pedir, { lineas, anticipo: 4999 })).status, 400);
  const r = await apartar(pedir, { lineas, anticipo: 5000, forma_pago: 'efectivo' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.pedido.anticipo, 5000);
  assert.equal(r.cuerpo.pedido.saldo, 5000);
  assert.equal(stockDe(db, prenda), 0);
  const c = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 55000 });
  assert.equal(c.cuerpo.efectivo_ventas, 5000);
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

/* ---------- Apartar desde el portal (#668) ---------- */

const SOCIA = { nombre: 'Lucía Socia', telefono: '4441112222' };
const OTRA_SOCIA = { nombre: 'Marta Otra', telefono: '4449998888' };
/** Una pieza que el catálogo público sí muestra (VENDIBLE: nombre legible, foto, etiqueta, existencia). */
const vendible = (db: DatabaseSync, precio: number, stock: number) => {
  const id = pieza(db, precio, stock, 'Chamarra Levis');
  return { id, codigo: (db.prepare('select codigo from productos where id = ?').get(id) as { codigo: string }).codigo };
};
const peticionPortal = (cuerpo: unknown) => new Request('https://portal.prueba/api/portal/apartar', { method: 'POST', body: JSON.stringify(cuerpo) }) as never;
const apartarEnPortal = async (t: ReturnType<typeof tienda>, codigo: string, extra: Record<string, unknown> = {}, socio = SOCIA) => {
  const cuerpo = { id: crypto.randomUUID(), codigo, entrega: 'tienda', ...extra };
  const r = await apartarPortal(peticionPortal(cuerpo), t.env, t.ctx as never, socio);
  return { status: r.status, cuerpo: (await r.json()) as Record<string, any>, id: cuerpo.id as string, cache: r.headers.get('cache-control') };
};
const filaPedido = (db: DatabaseSync, folio: number) => db.prepare('select * from pedidos where folio = ?').get(folio) as Record<string, any>;

test('apartar desde el portal (#668): sin anticipo, 24 h, datos del socio y de la pieza (no del navegador), stock -1 y reintento', async () => {
  const t = tienda();
  const { db, env } = t;
  const a = vendible(db, 25000, 2);
  (env as any).PORTAL_DATOS_PAGO = ' Banco de prueba\nTitular de prueba ';
  // Todo lo que el navegador agregue (precio, nombre, teléfono, anticipo, vendedora, caja) se ignora.
  const r = await apartarEnPortal(t, a.codigo, { cliente: 'Intruso', telefono: '4440000000', precio: 1, anticipo: 99999, vendedora: 'dueno@prueba.mx', caja: 'Caja 1', forma_pago: 'efectivo' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(Object.keys(r.cuerpo).sort(), ['a_pagar', 'concepto', 'datos_pago', 'pedido']);
  assert.deepEqual(Object.keys(r.cuerpo.pedido).sort(), ['entrega', 'envio', 'folio', 'lineas', 'subtotal', 'vence_en']);
  assert.equal(r.cuerpo.a_pagar, 10000);
  assert.equal(r.cuerpo.concepto, 'P-1');
  assert.equal(r.cuerpo.datos_pago, 'Banco de prueba\nTitular de prueba');
  assert.deepEqual(r.cuerpo.pedido.lineas, [{ codigo: a.codigo, nombre: 'Chamarra Levis', precio: 25000, cantidad: 1 }]);
  assert.equal(r.cuerpo.pedido.subtotal, 25000);
  const p = filaPedido(db, 1);
  assert.deepEqual([p.vendedora, p.cliente, p.telefono, p.anticipo, p.saldo, p.caja, p.forma_pago, p.estado, p.entrega, p.envio],
    ['portal', 'Lucía Socia', '4441112222', 0, 0, '', 'transferencia', 'apartado', 'tienda', 0]);
  assert.equal(HORAS_PORTAL, 24);
  assert.equal(Date.parse(p.vence_en) - Date.parse(p.creado_en), 24 * 3_600_000);
  assert.equal(p.vence_en, r.cuerpo.pedido.vence_en);
  assert.equal(stockDe(db, a.id), 1);

  // Reintento con el mismo id (respuesta perdida): el mismo pedido, sin bajar otra vez la existencia.
  const otra = await apartarPortal(peticionPortal({ id: r.id, codigo: a.codigo, entrega: 'tienda' }), env, t.ctx as never, SOCIA);
  assert.equal(otra.status, 200);
  assert.equal(((await otra.json()) as any).concepto, 'P-1');
  assert.equal(stockDe(db, a.id), 1);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);
  // Aunque esa fue la última unidad y la pieza ya no sea vendible, el reintento sigue respondiendo.
  const unica = vendible(db, 20000, 1);
  const primera = await apartarEnPortal(t, unica.codigo);
  assert.equal(primera.status, 201);
  assert.equal(stockDe(db, unica.id), 0);
  const reintento = await apartarPortal(peticionPortal({ id: primera.id, codigo: unica.codigo, entrega: 'tienda' }), env, t.ctx as never, SOCIA);
  assert.equal(reintento.status, 200);
  // El mismo id de otro socio no lee ni toma el pedido ajeno.
  const ajeno = await apartarPortal(peticionPortal({ id: primera.id, codigo: unica.codigo, entrega: 'tienda' }), env, t.ctx as never, OTRA_SOCIA);
  assert.equal(ajeno.status, 409);
  // Sin PORTAL_DATOS_PAGO la respuesta lo dice con null.
  delete (env as any).PORTAL_DATOS_PAGO;
  assert.equal((await apartarEnPortal(t, a.codigo)).cuerpo.datos_pago, null);
});

test('apartar desde el portal: tope de 3 sin pago por socio; el pago que registra la tienda libera un cupo y renueva a 7 días', async () => {
  const t = tienda();
  const { db, pedir } = t;
  const piezas = [0, 1, 2, 3].map(() => vendible(db, 25000, 1));
  for (const p of piezas.slice(0, APARTADOS_PORTAL)) assert.equal((await apartarEnPortal(t, p.codigo)).status, 201);
  const cuarta = await apartarEnPortal(t, piezas[3].codigo);
  assert.equal(cuarta.status, 409);
  assert.match(cuarta.cuerpo.error, /3 apartados sin pago/);
  assert.equal(stockDe(db, piezas[3].id), 1);   // la cuarta no se tocó
  // El tope es por socio: otra cuenta aparta aunque la primera esté al límite.
  assert.equal((await apartarEnPortal(t, piezas[3].codigo, {}, OTRA_SOCIA)).status, 201);

  // La tienda registra el abono del folio 1 (como con las revendedoras): ya no cuenta como "sin pago" y vence a 7 días.
  const abono = await abonar(pedir, 1, 10000, { forma_pago: 'transferencia' });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  const p1 = filaPedido(db, 1);
  assert.equal(p1.saldo, 10000);
  assert.ok(Math.abs(Date.parse(p1.vence_en) - Date.now() - 7 * 86_400_000) < 60_000, p1.vence_en);
  assert.equal((await apartarEnPortal(t, vendible(db, 25000, 1).codigo)).status, 201);
  assert.equal((await apartarEnPortal(t, vendible(db, 25000, 1).codigo)).status, 409);
});

test('apartar desde el portal: stock 0, pieza no vendible, FEP o inexistente se rechazan sin dejar pedido; dos socios por la última', async () => {
  const t = tienda();
  const { db } = t;
  const cero = vendible(db, 25000, 1);
  db.prepare('update productos set stock = 0 where id = ?').run(cero.id);
  const sinFoto = vendible(db, 25000, 1);
  db.prepare("update productos set foto_key = '' where id = ?").run(sinFoto.id);
  const fep = vendible(db, 25000, 1);
  db.prepare("update productos set propietario = 'fep' where id = ?").run(fep.id);
  const interna = vendible(db, 25000, 1);
  db.prepare("update productos set nombre = 'DAMA 150 12' where id = ?").run(interna.id);
  for (const p of [cero, sinFoto, fep, interna]) {
    const r = await apartarEnPortal(t, p.codigo);
    assert.equal(r.status, 409, p.codigo);
    assert.match(r.cuerpo.error, /ya no está disponible/);
  }
  assert.equal((await apartarEnPortal(t, 'ED-999999')).status, 404);
  assert.equal((await apartarEnPortal(t, 'quiero esa')).status, 400);
  assert.equal((await apartarEnPortal(t, '')).status, 400);
  assert.equal((await apartarEnPortal(t, vendible(db, 25000, 1).codigo, { entrega: 'correo' })).status, 400);
  assert.equal((await apartarEnPortal(t, vendible(db, 25000, 1).codigo, { id: 'no-es-uuid' })).status, 400);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 0);

  const ultima = vendible(db, 25000, 1);
  const [uno, dos] = [await apartarEnPortal(t, ultima.codigo), await apartarEnPortal(t, ultima.codigo, {}, OTRA_SOCIA)];
  assert.deepEqual([uno.status, dos.status], [201, 409]);
  assert.equal(stockDe(db, ultima.id), 0);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);
});

test('apartar desde el portal con envío: el servidor calcula el envío, abre con $100 y la tienda lo liquida con abonos', async () => {
  const t = tienda();
  const { db, pedir } = t;
  const a = vendible(db, 25000, 1);
  const r = await apartarEnPortal(t, a.codigo, { entrega: 'envio' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.pedido.entrega, r.cuerpo.pedido.envio, r.cuerpo.a_pagar], ['envio', 9900, 10000]);
  assert.equal(filaPedido(db, 1).anticipo, 0);
  // Envío + anticipo 0 acepta abonos (primero $100, luego lo que falta: $249); al completar se emite el ticket y no vence más.
  assert.equal((await abonar(pedir, 1, 10000, { forma_pago: 'efectivo' })).status, 200);
  const p1 = filaPedido(db, 1);
  assert.ok(Math.abs(Date.parse(p1.vence_en) - Date.now() - 7 * 86_400_000) < 60_000);
  const ultimo = await abonar(pedir, 1, 24900, { forma_pago: 'efectivo' });
  assert.equal(ultimo.status, 200, JSON.stringify(ultimo.cuerpo));
  assert.equal(filaPedido(db, 1).estado, 'vendido');
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 1);
  assert.equal(stockDe(db, a.id), 0);

  // Desde $1,000 el envío es gratis; bajo $100 la pieza se paga completa.
  const cara = await apartarEnPortal(t, vendible(db, 150000, 1).codigo, { entrega: 'envio' });
  assert.deepEqual([cara.cuerpo.pedido.envio, cara.cuerpo.a_pagar], [0, 10000]);
  const barata = await apartarEnPortal(t, vendible(db, 6000, 1).codigo);
  assert.deepEqual([barata.cuerpo.a_pagar, barata.cuerpo.pedido.subtotal], [6000, 6000]);
});

test('apartar desde el portal: a las 24 h el cron lo vence y devuelve la pieza una vez; con un pago por revisar no vence', async () => {
  const t = tienda();
  const { db, env } = t;
  const a = vendible(db, 25000, 1);
  const b = vendible(db, 25000, 1);
  await apartarEnPortal(t, a.codigo);
  await apartarEnPortal(t, b.codigo);
  // El pago que el socio reporta (#609/B2) deja el apartado en pausa para el cron.
  db.prepare("insert into pagos_reportados (pedido_id, solicitud_id, clave_rastreo, reportado_por, reportado_en) values ((select id from pedidos where folio = 2), ?, 'ABCDEF12', 'portal:x', ?)")
    .run(crypto.randomUUID(), new Date().toISOString());
  assert.equal(await vencerPedidos(env, new Date(Date.now() + 23 * 3_600_000)), 0);
  assert.equal(await vencerPedidos(env, new Date(Date.now() + 25 * 3_600_000)), 1);
  assert.equal(await vencerPedidos(env, new Date(Date.now() + 25 * 3_600_000)), 0);
  assert.equal(stockDe(db, a.id), 1);
  assert.equal(stockDe(db, b.id), 0);
  assert.equal(filaPedido(db, 1).estado, 'vencido');
  assert.equal(filaPedido(db, 2).estado, 'apartado');
});

/* ---------- Carrito: apartar varias piezas en un pedido (#681) ---------- */

const apartarVarias = async (t: ReturnType<typeof tienda>, codigos: unknown, extra: Record<string, unknown> = {}, socio = SOCIA) => {
  const cuerpo = { id: crypto.randomUUID(), codigos, entrega: 'tienda', ...extra };
  const r = await apartarPortal(peticionPortal(cuerpo), t.env, t.ctx as never, socio);
  return { status: r.status, cuerpo: (await r.json()) as Record<string, any>, id: cuerpo.id as string };
};

test('carrito (#681): 3 piezas = un pedido, -1 de cada existencia en el mismo batch, $100 por todo y reintento idéntico', async () => {
  const t = tienda();
  const { db } = t;
  const [a, b, c] = [vendible(db, 25000, 2), vendible(db, 18000, 1), vendible(db, 6000, 1)];
  // Los códigos repetidos cuentan una vez (son piezas únicas) y las minúsculas se normalizan.
  const r = await apartarVarias(t, [a.codigo, b.codigo.toLowerCase(), c.codigo, a.codigo]);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.pedido.lineas.length, 3);
  assert.deepEqual(r.cuerpo.pedido.lineas.map((l: any) => l.cantidad), [1, 1, 1]);
  assert.equal(r.cuerpo.pedido.subtotal, 49000);
  assert.equal(r.cuerpo.a_pagar, 10000);   // $100 por todo el pedido
  assert.equal(r.cuerpo.concepto, 'P-1');
  assert.deepEqual([stockDe(db, a.id), stockDe(db, b.id), stockDe(db, c.id)], [1, 0, 0]);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);
  assert.equal((db.prepare('select count(*) as n from pedido_lineas').get() as { n: number }).n, 3);
  const p = filaPedido(db, 1);
  assert.deepEqual([p.vendedora, p.telefono, p.anticipo, p.saldo], ['portal', '4441112222', 0, 0]);

  // Reintento con el mismo id y los mismos códigos (respuesta perdida): el mismo pedido, sin bajar otra vez las existencias.
  const otra = await apartarPortal(peticionPortal({ id: r.id, codigos: [a.codigo, b.codigo, c.codigo], entrega: 'tienda' }), t.env, t.ctx as never, SOCIA);
  assert.equal(otra.status, 200);
  assert.equal(((await otra.json()) as any).pedido.lineas.length, 3);
  assert.deepEqual([stockDe(db, a.id), stockDe(db, b.id), stockDe(db, c.id)], [1, 0, 0]);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1);
});

test('carrito (#681): $100 por todo el pedido aunque las piezas sean baratas; si todo cuesta menos, se paga completo; el envío sale del subtotal', async () => {
  const t = tienda();
  const { db } = t;
  const baratas = [vendible(db, 4000, 1), vendible(db, 4000, 1), vendible(db, 4000, 1)];   // $120 juntas
  assert.equal((await apartarVarias(t, baratas.map((x) => x.codigo))).cuerpo.a_pagar, 10000);
  const dos = [vendible(db, 3000, 1), vendible(db, 3000, 1)];   // $60 juntas: se paga completo
  const completo = await apartarVarias(t, dos.map((x) => x.codigo));
  assert.deepEqual([completo.cuerpo.a_pagar, completo.cuerpo.pedido.subtotal], [6000, 6000]);
  // Envío: $99 bajo $1,000 de subtotal total; gratis desde $1,000 sumando las piezas.
  const medias = [vendible(db, 30000, 1), vendible(db, 30000, 1)];
  const conEnvio = await apartarVarias(t, medias.map((x) => x.codigo), { entrega: 'envio' });
  assert.deepEqual([conEnvio.cuerpo.pedido.subtotal, conEnvio.cuerpo.pedido.envio, conEnvio.cuerpo.a_pagar], [60000, 9900, 10000]);
  const cuatro = [0, 1, 2, 3].map(() => vendible(db, 30000, 1));
  db.prepare("update pedidos set estado = 'cancelado'").run();   // libera el tope solo para esta prueba
  const gratis = await apartarVarias(t, cuatro.map((x) => x.codigo), { entrega: 'envio' });
  assert.deepEqual([gratis.cuerpo.pedido.subtotal, gratis.cuerpo.pedido.envio], [120000, 0]);
});

test('carrito (#681): una pieza agotada = 409 con sus códigos y ninguna existencia tocada; quitada, el mismo carrito sí pasa', async () => {
  const t = tienda();
  const { db } = t;
  const [a, b, c] = [vendible(db, 25000, 1), vendible(db, 25000, 1), vendible(db, 25000, 1)];
  db.prepare('update productos set stock = 0 where id = ?').run(b.id);
  const sinB = await apartarVarias(t, [a.codigo, b.codigo, c.codigo]);
  assert.equal(sinB.status, 409);
  assert.deepEqual(sinB.cuerpo.no_disponibles, [b.codigo]);
  assert.match(sinB.cuerpo.error, /^Una pieza ya no está disponible/);
  assert.deepEqual([stockDe(db, a.id), stockDe(db, c.id)], [1, 1]);
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 0);
  // Dos agotadas: las dos en la lista.
  db.prepare('update productos set stock = 0 where id = ?').run(c.id);
  const dos = await apartarVarias(t, [a.codigo, b.codigo, c.codigo]);
  assert.deepEqual(dos.cuerpo.no_disponibles, [b.codigo, c.codigo]);
  assert.match(dos.cuerpo.error, /^2 piezas ya no están disponibles/);
  // Código que no existe: 404 con su código.
  const noHay = await apartarVarias(t, [a.codigo, 'ED-999999']);
  assert.equal(noHay.status, 404);
  assert.deepEqual(noHay.cuerpo.no_disponibles, ['ED-999999']);
  // La pantalla quita las que ya no están y vuelve a intentar con las demás.
  const bien = await apartarVarias(t, [a.codigo]);
  assert.equal(bien.status, 201);
  assert.equal(stockDe(db, a.id), 0);
});

test('carrito (#681): si una pieza se vende entre la lectura y el batch, el batch entero se deshace y el 409 dice cuál', async () => {
  const t = tienda();
  const { db, env } = t;
  const [a, b] = [vendible(db, 25000, 1), vendible(db, 25000, 1)];
  const batch = env.DB.batch.bind(env.DB);
  // Otra socia se lleva la b justo antes de que corra el batch de esta.
  env.DB.batch = (async (sentencias: D1PreparedStatement[]) => { db.prepare('update productos set stock = 0 where id = ?').run(b.id); return batch(sentencias); }) as typeof env.DB.batch;
  const r = await apartarVarias(t, [a.codigo, b.codigo]);
  assert.equal(r.status, 409);
  assert.deepEqual(r.cuerpo.no_disponibles, [b.codigo]);
  assert.equal(stockDe(db, a.id), 1);   // la a no se tocó: ni pedido ni líneas a medias
  assert.equal((db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select count(*) as n from pedido_lineas').get() as { n: number }).n, 0);
});

test('carrito (#681): `codigo` suelto sigue valiendo; el tope de 3 es por pedido (no por pieza); 10 piezas máximo; lista vacía o mala = 400', async () => {
  const t = tienda();
  const { db } = t;
  assert.equal((await apartarEnPortal(t, vendible(db, 25000, 1).codigo)).status, 201);   // contrato anterior
  // Tres pedidos sin pago (1 + 3 + 3 piezas) llenan el tope; el cuarto se rechaza por pedidos, no por piezas.
  assert.equal((await apartarVarias(t, [0, 1, 2].map(() => vendible(db, 25000, 1).codigo))).status, 201);
  assert.equal((await apartarVarias(t, [0, 1, 2].map(() => vendible(db, 25000, 1).codigo))).status, 201);
  const cuarto = await apartarVarias(t, [vendible(db, 25000, 1).codigo]);
  assert.equal(cuarto.status, 409);
  assert.match(cuarto.cuerpo.error, /3 apartados sin pago/);
  const otra = { nombre: 'Marta Otra', telefono: '4449998888' };
  const diez = Array.from({ length: 10 }, () => vendible(db, 25000, 1));
  const r10 = await apartarVarias(t, diez.map((x) => x.codigo), {}, otra);
  assert.equal(r10.status, 201, JSON.stringify(r10.cuerpo));   // diez piezas en un solo pedido cuentan como un apartado
  assert.equal(r10.cuerpo.pedido.lineas.length, 10);
  const once = Array.from({ length: 11 }, () => vendible(db, 25000, 1));
  const r11 = await apartarVarias(t, once.map((x) => x.codigo), {}, otra);
  assert.equal(r11.status, 400);
  assert.deepEqual(once.map((x) => stockDe(db, x.id)), once.map(() => 1));
  for (const malo of [[], 'ED-000101', [''], ['ED-1', 'otra cosa'], [123], null]) assert.equal((await apartarVarias(t, malo, {}, otra)).status, 400, JSON.stringify(malo));
});

test('carrito (#681): cancelar un pedido de varias piezas devuelve todas las existencias, una sola vez', async () => {
  const t = tienda();
  const { db, env } = t;
  const [a, b, c] = [vendible(db, 25000, 1), vendible(db, 25000, 2), vendible(db, 25000, 1)];
  assert.equal((await apartarVarias(t, [a.codigo, b.codigo, c.codigo])).status, 201);
  assert.deepEqual([stockDe(db, a.id), stockDe(db, b.id), stockDe(db, c.id)], [0, 1, 0]);
  const [x, y] = await Promise.all([cancelarDeSocio(1, env, t.ctx as never, SOCIA.telefono), cancelarDeSocio(1, env, t.ctx as never, SOCIA.telefono)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.deepEqual([stockDe(db, a.id), stockDe(db, b.id), stockDe(db, c.id)], [1, 2, 1]);
});
