// node --test src/pedidos.test.ts
// Pedidos por WhatsApp, fase 1 (Issue #269) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, codigoPrueba } from './prueba-d1.ts';
import { permiso } from './cuentas.ts';
import { PUBLICABLE } from './mercadolibre.ts';
import { vencerPedidos, telefonoDe } from './pedidos.ts';
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
  return pedir('/api/pedidos', cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const vender = (pedir: ReturnType<typeof tienda>['pedir'], extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra,
  };
  return pedir('/api/ventas', venta).then((r) => ({ ...r, id: venta.id as string }));
};

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

test('reglas del pedido: anticipo minimo, envio $99 bajo $1,000 y pagado completo, telefono, piezas con etiqueta, caja en efectivo', async () => {
  const { db, pedir } = tienda();
  assert.equal(telefonoDe('+52 (444) 123-4567'), '4441234567');
  assert.equal(telefonoDe('123'), null);

  assert.equal((await apartar(pedir, { anticipo: 9999 })).status, 400);
  assert.equal((await apartar(pedir, { anticipo: 25001 })).status, 400);          // pasa del total
  assert.equal((await apartar(pedir, { cliente: '  ' })).status, 400);
  assert.equal((await apartar(pedir, { telefono: '12345' })).status, 400);
  assert.equal((await apartar(pedir, { entrega: 'correo' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'cheque' })).status, 400);
  assert.equal((await apartar(pedir, { forma_pago: 'efectivo', caja: '' })).status, 400);
  assert.equal((await apartar(pedir, { lineas: [] })).status, 400);
  assert.equal((await apartar(pedir, { lineas: [{ producto_id: crypto.randomUUID(), cantidad: 1 }] })).status, 400);
  const banda = (db.prepare(`select id from productos where sin_inventario = 1 limit 1`).get() as { id: string }).id;
  const sinEtiqueta = await apartar(pedir, { lineas: [{ producto_id: banda, cantidad: 1 }] });
  assert.equal(sinEtiqueta.status, 400);
  assert.equal(sinEtiqueta.cuerpo.error, 'Solo piezas con etiqueta.');
  assert.equal(stockDe(db, PRODUCTO), 50);

  // $250 + $99 de envio = $349: se paga completo.
  assert.equal((await apartar(pedir, { entrega: 'envio', anticipo: 10000 })).status, 400);
  const envio = await apartar(pedir, { entrega: 'envio', anticipo: 34900, telefono: '524441234567' });
  assert.equal(envio.status, 201, JSON.stringify(envio.cuerpo));
  assert.equal(envio.cuerpo.pedido.envio, 9900);
  assert.equal(envio.cuerpo.pedido.telefono, '4441234567');
  // Desde $1,000 el envio es gratis.
  const gratis = await apartar(pedir, { entrega: 'envio', lineas: [{ producto_id: PRODUCTO, cantidad: 4 }], anticipo: 100000 });
  assert.equal(gratis.status, 201, JSON.stringify(gratis.cuerpo));
  assert.equal(gratis.cuerpo.pedido.envio, 0);
});

test('la lista trae apartados por vencimiento, envios por mandar y saldos a favor; la guia solo en envios', async () => {
  const { db, pedir } = tienda();
  const tarde = await apartar(pedir, { cliente: 'Tarde' });
  const pronto = await apartar(pedir, { cliente: 'Pronto' });
  db.prepare('update pedidos set vence_en = ? where id = ?').run('2020-01-01T00:00:00.000Z', pronto.id);
  const envio = await apartar(pedir, { entrega: 'envio', anticipo: 25000 + 9900, cliente: 'Envio' });
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
