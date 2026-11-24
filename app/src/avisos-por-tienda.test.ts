// node --test src/avisos-por-tienda.test.ts
// #921: /api/avisos entrega a cada caja solo las transferencias por validar de su tienda y las ventas de Mercado Libre solo a Soledad y gerencia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO, datosTransferencia } from './prueba-d1.ts';

const DUENO_SALK = 'duenosalk@prueba.mx';
const CAJERO = { soledad: 'cajerosoledad@prueba.mx', salk: 'cajerosalk@prueba.mx', romero: 'cajeroromero@prueba.mx' };

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    (?, 'Dueño Salk', 'dueno', 1, 'salk', '', ''), (?, 'Cajero Soledad', 'cajero', 1, '', '', ''),
    (?, 'Cajero Salk', 'cajero', 1, 'salk', '', ''), (?, 'Cajero Romero', 'cajero', 1, 'romero', '', '')`)
    .run(DUENO_SALK, CAJERO.soledad, CAJERO.salk, CAJERO.romero);
  t.db.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 10, '')`).run(PRODUCTO);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const vender = async (correo: string, caja: string) => {
    como(correo);
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'transferencia', caja, promo: 0, ...datosTransferencia(50000) });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return id;
  };
  const porValidar = () => t.db.prepare(`update transferencias_spei set cep_estado = 'no_encontrada'`).run();
  const pedido = (id: string, folio: number, caja: string, recogeEn: string) => t.db.prepare(
    `insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, saldo, forma_pago, saldo_vence_en, caja, recoge_en, creado_en, actualizado_en)
     values (?, ?, 'X', '4441234567', 'tienda', 'portal', 'apartado', 'z', 10000, 0, 'transferencia', 'z', ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(id, folio, caja, recogeEn);
  const spei = (clave: string, origen: string, pedidoId: string, movimientoId: string | null) => t.db.prepare(
    `insert into transferencias_spei (clave_rastreo, monto, aplicado, origen, pedido_id, movimiento_id, registrado_por, registrado_en) values (?, 10000, 10000, ?, ?, ?, 'x', '2026-11-01T00:00:00Z')`)
    .run(clave, origen, pedidoId, movimientoId);
  const leer = async (correo: string) => { como(correo); const r = await t.pedir('/api/avisos'); assert.equal(r.status, 200, correo); return r.cuerpo as any; };
  const ml = () => t.db.prepare(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('O1', 'I1', ?, 1, 'descontada', 1, '2026-11-01T00:00:00.000Z')`).run(PRODUCTO);
  return { ...t, como, vender, porValidar, pedido, spei, leer, ml };
}

test('transferencias por validar: cada caja recibe las de su tienda; gerencia, todas', async () => {
  const m = await montar();
  const ventaSoledad = await m.vender(DUENO, 'Caja 1');
  const ventaSalk = await m.vender(DUENO_SALK, 'Salk 1');
  m.pedido('p1', 1, 'Romero 1', 'romero');        // anticipo cobrado en una caja de Romero
  m.pedido('p2', 2, '', 'salk');                  // anticipo sin caja: la tienda donde se recoge
  m.pedido('p3', 3, 'Salk 1', 'romero');          // abono cobrado en Caja 2 (Soledad), aunque el pedido se recoge en Romero
  m.db.prepare(`insert into pedido_movimientos (id, pedido_id, tipo, solicitud, importe, forma_pago, caja, autor, creado_en, respuesta) values ('m3', 'p3', 'abono', 's', 10000, 'transferencia', 'Caja 2', 'x', '', '')`).run();
  m.spei('PRUEBAP1ANTICIPO', 'anticipo', 'p1', null);
  m.spei('PRUEBAP2ANTICIPO', 'anticipo', 'p2', null);
  m.spei('PRUEBAP3ABONO', 'abono', 'p3', 'm3');
  m.porValidar();
  const claves = async (correo: string) => (await m.leer(correo)).transferencias.map((f: any) => f.donde).sort();
  const tick = (id: string) => `Ticket ${id.slice(0, 8).toUpperCase()}`;
  assert.deepEqual(await claves(CAJERO.soledad), [tick(ventaSoledad), 'Pedido P-3'].sort());
  assert.deepEqual(await claves(CAJERO.salk), [tick(ventaSalk), 'Pedido P-2'].sort());
  assert.deepEqual(await claves(CAJERO.romero), ['Pedido P-1']);
  assert.equal((await claves(DUENO)).length, 5);
  assert.equal((await claves(DUENO_SALK)).length, 5);
});

test('ventas de Mercado Libre: solo Soledad y gerencia las ven y las atienden; una sucursal recibe lista vacía y 403', async () => {
  const m = await montar();
  m.ml();
  const ordenes = async (correo: string) => (await m.leer(correo)).ventas_ml.length;
  assert.equal(await ordenes(CAJERO.soledad), 1);
  assert.equal(await ordenes(DUENO), 1);
  assert.equal(await ordenes(DUENO_SALK), 1);
  assert.equal(await ordenes(CAJERO.salk), 0);
  assert.equal(await ordenes(CAJERO.romero), 0);
  m.como(CAJERO.salk);
  const r = await m.pedir('/api/avisos/ml/O1/I1', {});
  assert.equal(r.status, 403);
  assert.equal((m.db.prepare(`select atendida_en from ml_ventas`).get() as { atendida_en: string }).atendida_en, '');
  m.como(CAJERO.soledad);
  assert.equal((await m.pedir('/api/avisos/ml/O1/I1', {})).status, 200);
  assert.notEqual((m.db.prepare(`select atendida_en from ml_ventas`).get() as { atendida_en: string }).atendida_en, '');
});
