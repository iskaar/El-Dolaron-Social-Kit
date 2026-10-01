// node --test src/venta-servidor.test.ts
// El servidor nunca confia en lo que manda la caja para precio, nombre o codigo:
// esos salen del catalogo. Aqui se prueba esa regla sin tocar D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararLineas } from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const catalogo = () => new Map([
  ['a1111111-1111-4111-8111-111111111111',
    { id: 'a1111111-1111-4111-8111-111111111111', codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, sin_inventario: 0 }],
  ['00000000-0000-4000-8000-200000000019',
    { id: '00000000-0000-4000-8000-200000000019', codigo: 'G19', nombre: 'General $19', precio: 1900, sin_inventario: 1 }],
]);

test('un precio alterado por el navegador se ignora: manda el del catalogo', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'a1111111-1111-4111-8111-111111111111', precio: 1, cantidad: 1 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].precio, 25000);
});

test('producto inexistente: 4xx logico, no hay linea que registrar', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'no-existe', cantidad: 1 }],
    catalogo(),
  );
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /inexistente/);
});

test('cantidad invalida: cero, negativa o no entera se rechaza', () => {
  for (const cantidad of [0, -1, 1.5, NaN]) {
    const resultado = prepararLineas(
      [{ producto_id: 'a1111111-1111-4111-8111-111111111111', cantidad }],
      catalogo(),
    );
    assert.equal(resultado.ok, false, `cantidad ${cantidad} deberia rechazarse`);
  }
});

test('un ticket vacio no produce lineas', () => {
  const resultado = prepararLineas([], catalogo());
  assert.equal(resultado.ok, false);
});

test('la banda se marca sin inventario: la caja no le descuenta existencia', () => {
  const resultado = prepararLineas(
    [{ producto_id: '00000000-0000-4000-8000-200000000019', cantidad: 3 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].sinInventario, true);
  assert.equal(resultado.lineas[0].precio, 1900);
});

test('la puerta del vendedor deja corregir la existencia, y nada mas de una pieza', async () => {
  const { permitidaParaVendedor } = await import('./worker.ts');
  const id = 'a1111111-1111-4111-8111-111111111111';
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'PATCH'), true);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'GET'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'PATCH'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'DELETE'), false);
  assert.equal(permitidaParaVendedor('/api/borradores', 'GET'), false);
  assert.equal(permitidaParaVendedor('/api/borradores', 'POST'), true);
});

test('un folio acepta sólo el mismo pedido; el catálogo posterior no altera el reintento', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000, creado_en:'2026-10-02T18:00:00.000Z' };
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    t.db.prepare('update productos set precio=30000 where id=?').run(PRODUCTO);
    assert.equal((await t.pedir('/api/ventas', v)).cuerpo.duplicada, true);
    for (const cambiado of [
      { ...v, efectivo:30000 }, { ...v, lineas:[{ producto_id:PRODUCTO, cantidad:2 }] },
      { ...v, forma_pago:'tarjeta' },
    ]) assert.equal((await t.pedir('/api/ventas', cambiado)).status, 409);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 1);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('una confirmación entre prelectura y batch se resuelve por el pedido confirmado', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000 };
    const original = t.env.DB.batch.bind(t.env.DB);
    t.env.DB.batch = async (sentencias) => {
      t.env.DB.batch = original;
      assert.equal((await t.pedir('/api/ventas', v)).status, 201);
      return original(sentencias);
    };
    const r = await t.pedir('/api/ventas', v);
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.duplicada, true);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('el reintento de un folio vale aunque cambie el cajero en turno o la venta sea anterior a la huella', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000 };
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
      values ('otro@prueba.mx', 'Otra', 'dueno', 1, '', '')`).run();
    t.env.DEV_USUARIO = 'otro@prueba.mx';
    assert.equal((await t.pedir('/api/ventas', v)).cuerpo.duplicada, true);
    t.db.prepare('update ventas set pedido_hash = null where id = ?').run(v.id);
    assert.equal((await t.pedir('/api/ventas', { ...v, efectivo:30000 })).cuerpo.duplicada, true);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});
