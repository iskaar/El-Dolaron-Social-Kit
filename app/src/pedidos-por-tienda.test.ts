// node --test src/pedidos-por-tienda.test.ts
// #920: cada tienda ve y opera solo los pedidos que recoge o levantó; gerencia, todos. Un saldo a favor vigente se cobra en cualquier caja.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { apartarRevendedora } from './pedidos.ts';

const CAJERA_SOLEDAD = 'cajasoledad@prueba.mx';
const CAJERA_SALK = 'cajasalk@prueba.mx';
const CAJERA_ROMERO = 'cajaromero@prueba.mx';
const REVENDEDORA_ROMERO = 'revromero@prueba.mx';
const REVENDEDORA_SIN_TIENDA = 'revsin@prueba.mx';
const CAJA = { soledad: 'Caja 1', salk: 'Salk 1', romero: 'Romero 1' } as const;

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    (?, 'Caja Soledad', 'cajero', 1, '', '', ''), (?, 'Caja Salk', 'cajero', 1, 'salk', '', ''), (?, 'Caja Romero', 'cajero', 1, 'romero', '', ''),
    (?, 'Rev Romero', 'revendedora', 1, 'romero', '', ''), (?, 'Rev Sin', 'revendedora', 1, '', '', '')`)
    .run(CAJERA_SOLEDAD, CAJERA_SALK, CAJERA_ROMERO, REVENDEDORA_ROMERO, REVENDEDORA_SIN_TIENDA);
  for (const clave of ['salk', 'romero'])
    t.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, ?, 10, '')").run(PRODUCTO, clave);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const cuenta = { soledad: CAJERA_SOLEDAD, salk: CAJERA_SALK, romero: CAJERA_ROMERO } as const;
  const pedir = (quien: string, ruta: string, cuerpo?: unknown, metodo = cuerpo === undefined ? 'GET' : 'POST') => { como(quien); return t.pedir(ruta, cuerpo, metodo); };
  /** Un apartado levantado en la caja de `desde`, para recoger en `recoge`. */
  const apartar = async (desde: keyof typeof cuenta, recoge: keyof typeof cuenta, cliente: string) => {
    const r = await pedir(cuenta[desde], '/api/pedidos', {
      id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente, telefono: '4441234567', entrega: 'tienda',
      anticipo: 10000, forma_pago: 'efectivo', caja: CAJA[desde], recoge_en: recoge,
    });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return { id: r.cuerpo.pedido.id as string, folio: r.cuerpo.pedido.folio as number };
  };
  const clientes = async (quien: string) => ((await pedir(quien, '/api/pedidos')).cuerpo.pedidos as { cliente: string }[]).map((p) => p.cliente).sort();
  /** Todo lo que una acción rechazada no debe tocar. */
  const huella = () => JSON.stringify([
    t.db.prepare('select * from pedidos order by folio').all(), t.db.prepare('select * from pedido_lineas order by pedido_id, producto_id').all(),
    t.db.prepare('select count(*) n from pedido_movimientos').get(), t.db.prepare('select stock from productos where id = ?').get(PRODUCTO),
    t.db.prepare('select * from existencia_tienda order by tienda').all(),
  ]);
  return { ...t, como, pedir, apartar, clientes, cuenta, huella };
}

test('la lista de cada sesión trae solo sus pedidos: los que recoge, los que levantó su caja o su cuenta; gerencia, todos', async () => {
  const m = montar();
  await m.apartar('soledad', 'soledad', 'Soledad propio');
  await m.apartar('salk', 'salk', 'Salk propio');
  await m.apartar('salk', 'romero', 'Salk para Romero');   // lo levantó Salk y se recoge en Romero
  await m.apartar('romero', 'soledad', 'Romero para Soledad');
  assert.deepEqual(await m.clientes(CAJERA_SOLEDAD), ['Romero para Soledad', 'Soledad propio']);
  assert.deepEqual(await m.clientes(CAJERA_SALK), ['Salk para Romero', 'Salk propio']);
  assert.deepEqual(await m.clientes(CAJERA_ROMERO), ['Romero para Soledad', 'Salk para Romero']);
  assert.deepEqual(await m.clientes(DUENO), ['Romero para Soledad', 'Salk para Romero', 'Salk propio', 'Soledad propio']);
});

test('una revendedora sin caja: lo ve la tienda donde se recoge y la tienda de su cuenta (sin tienda = Soledad); el portal solo donde se recoge', async () => {
  const m = montar();
  const levantar = async (correo: string, recoge: string, cliente: string) => {
    const r = await apartarRevendedora(new Request('https://x/api/vender/apartar', { method: 'POST', body: JSON.stringify({
      id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente, telefono: '4441234567', entrega: 'tienda', recoge_en: recoge }) }) as never,
    m.env, m.ctx as never, correo);
    assert.equal(r.status, 201, JSON.stringify(await r.json()));
  };
  await levantar(REVENDEDORA_ROMERO, 'salk', 'Rev de Romero en Salk');
  await levantar(REVENDEDORA_SIN_TIENDA, 'romero', 'Rev sin tienda en Romero');
  assert.deepEqual(await m.clientes(CAJERA_SALK), ['Rev de Romero en Salk']);
  assert.deepEqual(await m.clientes(CAJERA_ROMERO), ['Rev de Romero en Salk', 'Rev sin tienda en Romero']);
  assert.deepEqual(await m.clientes(CAJERA_SOLEDAD), ['Rev sin tienda en Romero']);
  // 'portal' no es una cuenta: sin caja ni cuenta, solo cuenta donde se recoge (nunca Soledad por omisión).
  m.db.prepare("update pedidos set vendedora = 'portal' where cliente = 'Rev sin tienda en Romero'").run();
  assert.deepEqual(await m.clientes(CAJERA_SOLEDAD), []);
  assert.deepEqual(await m.clientes(CAJERA_ROMERO), ['Rev de Romero en Salk', 'Rev sin tienda en Romero']);
});

test('folio de otra tienda con apartado activo: 403 con la tienda donde se recoge y ningún dato del cliente; el propio y gerencia, completo', async () => {
  const m = montar();
  const p = await m.apartar('soledad', 'soledad', 'Nombre Secreto');
  for (const quien of [CAJERA_SALK, CAJERA_ROMERO]) {
    const r = await m.pedir(quien, `/api/pedidos/${p.folio}`);
    assert.equal(r.status, 403);
    assert.deepEqual(r.cuerpo, { error: `El pedido P-${p.folio} es de otra tienda: se recoge en Soledad.` });
    assert.doesNotMatch(JSON.stringify(r.cuerpo), /Secreto|4441234567/);
  }
  for (const quien of [CAJERA_SOLEDAD, DUENO]) {
    const r = await m.pedir(quien, `/api/pedidos/${p.folio}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.cuerpo.pedido.cliente, r.cuerpo.pedido.telefono, r.cuerpo.pedido.pagos.length], ['Nombre Secreto', '4441234567', 1]);
  }
  assert.equal((await m.pedir(CAJERA_SALK, '/api/pedidos/999')).status, 404, 'un folio inexistente sigue siendo 404');
  // Levantado en Salk para recoger en Romero: lo ven Salk y Romero, no Soledad.
  const c = await m.apartar('salk', 'romero', 'Levantado en Salk');
  const estados = [];
  for (const quien of [CAJERA_SALK, CAJERA_ROMERO, CAJERA_SOLEDAD]) estados.push((await m.pedir(quien, `/api/pedidos/${c.folio}`)).status);
  assert.deepEqual(estados, [200, 200, 403]);
});

test('saldo a favor vigente de otra tienda: respuesta mínima (nombre, sin teléfono, sin pagos, sin quién lo levantó) y la caja lo sigue cobrando', async () => {
  const m = montar();
  const p = await m.apartar('soledad', 'soledad', 'Clienta Saldo');
  assert.equal((await m.pedir(CAJERA_SOLEDAD, `/api/pedidos/${p.folio}/cancelar`, {})).status, 200);
  const r = await m.pedir(CAJERA_SALK, `/api/pedidos/${p.folio}`);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  const q = r.cuerpo.pedido;
  assert.deepEqual([q.cliente, q.telefono, q.estado, q.saldo, q.pagos, q.vendedora, q.caja, q.recoge_en], ['Clienta Saldo', '', 'cancelado', 10000, undefined, undefined, undefined, undefined]);
  assert.ok(q.saldo_vence_en > new Date().toISOString());
  assert.doesNotMatch(JSON.stringify(r.cuerpo), /4441234567|cajasoledad/);
  // Y se gasta en Salk como hoy.
  const venta = await m.pedir(CAJERA_SALK, '/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 15000, caja: 'Salk 1', pedido_id: q.id, anticipo: q.saldo });
  assert.equal(venta.status, 201, JSON.stringify(venta.cuerpo));
  assert.equal(venta.cuerpo.saldo_pedido, 0);
  // Con el saldo vencido o gastado, de otra tienda ya no se entrega nada.
  const otra = await m.pedir(CAJERA_SALK, `/api/pedidos/${p.folio}`);
  assert.equal(otra.status, 403);
  const v = await m.apartar('soledad', 'soledad', 'Vencida');
  await m.pedir(CAJERA_SOLEDAD, `/api/pedidos/${v.folio}/cancelar`, {});
  m.db.prepare("update pedidos set saldo_vence_en = '2020-01-01T00:00:00.000Z' where id = ?").run(v.id);
  assert.equal((await m.pedir(CAJERA_SALK, `/api/pedidos/${v.folio}`)).status, 403);
  assert.equal((await m.pedir(CAJERA_SOLEDAD, `/api/pedidos/${v.folio}`)).status, 200);
});

test('cancelar, rechazar pago, agregar pieza, abonar y guardar guía desde otra tienda: 403 y D1 queda igual; la tienda del pedido y gerencia sí operan', async () => {
  const m = montar();
  const p = await m.apartar('soledad', 'soledad', 'Operado');
  const e = await m.apartar('soledad', 'soledad', 'Paquete');
  m.db.prepare("update pedidos set entrega = 'envio', recoge_en = 'soledad' where id = ?").run(e.id);
  const antes = m.huella();
  const intentos: [string, string, unknown][] = [
    [`/api/pedidos/${p.folio}/cancelar`, 'POST', {}],
    [`/api/pedidos/${p.folio}/rechazar-pago`, 'POST', { motivo: 'no llegó' }],
    [`/api/pedidos/${e.folio}/piezas`, 'POST', { id: crypto.randomUUID(), producto_id: PRODUCTO, cantidad: 1 }],
    [`/api/pedidos/${e.folio}/abonos`, 'POST', { id: crypto.randomUUID(), importe: 5000, forma_pago: 'efectivo', caja: 'Salk 1' }],
    [`/api/pedidos/${e.folio}/guia`, 'PUT', { guia: 'DHL 1' }],
  ];
  for (const quien of [CAJERA_SALK, CAJERA_ROMERO]) for (const [ruta, metodo, cuerpo] of intentos) {
    const r = await m.pedir(quien, ruta, cuerpo, metodo);
    assert.equal(r.status, 403, `${quien} ${metodo} ${ruta}: ${JSON.stringify(r.cuerpo)}`);
    assert.match(r.cuerpo.error, /es de otra tienda: se recoge en Soledad\.$/);
  }
  assert.equal(m.huella(), antes, 'ninguna acción rechazada tocó D1');
  // Un folio inexistente sigue siendo 404 y no un 403.
  assert.equal((await m.pedir(CAJERA_SALK, '/api/pedidos/999/cancelar', {})).status, 404);
  // La tienda del pedido sí opera, y gerencia desde cualquier cuenta.
  assert.equal((await m.pedir(CAJERA_SOLEDAD, `/api/pedidos/${p.folio}/cancelar`, {})).status, 200);
  const abono = await m.pedir(DUENO, `/api/pedidos/${e.folio}/abonos`, { id: crypto.randomUUID(), importe: 5000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
});
