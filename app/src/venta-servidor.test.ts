// node --test src/venta-servidor.test.ts
// El servidor nunca confia en lo que manda la caja para precio, nombre o codigo:
// esos salen del catalogo. Aqui se prueba esa regla sin tocar D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, efectivoAlcanza, saldoCanjeable } from '../public/venta.js';
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

test('líneas nulas o no objetos responden 400 sin registrar venta ni descontar stock', async () => {
  const t = tienda();
  try {
    for (const linea of [null, false, 1, 'pieza', [], {}]) {
      const r = await t.pedir('/api/ventas', { id:crypto.randomUUID(),
        lineas:[{ producto_id:PRODUCTO, cantidad:1 }, linea], efectivo:25000 });
      assert.equal(r.status, 400, JSON.stringify({ linea, respuesta:r.cuerpo }));
      assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
      assert.equal(t.db.prepare('select count(*) as n from venta_lineas').get()!.n, 0);
      assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
    }
  } finally { t.db.close(); }
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

test('caja reintenta un canje tras perder la respuesta con el mismo folio, fecha y pedido_hash', async () => {
  const t = tienda();
  try {
    t.env.VALES_ABIERTOS = 'si';
    const emitida = await t.pedir('/api/ventas', { id: crypto.randomUUID(),
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], efectivo: 25000, caja: 'Caja 1' });
    const vale = emitida.cuerpo.vale_emitido;
    t.db.prepare("update vales_dolarones set disponible_desde = '2000-01-01T00:00:00Z'").run();
    const fuente = readFileSync('public/caja.html', 'utf8');
    const cobrar = fuente.slice(fuente.indexOf('async function cobrar()'), fuente.indexOf('let sincronizando = false;'));
    const respuestas: number[] = [];
    let reloj = 0;
    // Ejecutar el cobro real con una primera respuesta perdida. Devolver false mantiene el ticket abierto.
    const repetir = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false;
      ${cobrar}; cobrar`, {
      crypto, Date: class extends Date { constructor() { super(1760000000000 + reloj++ * 1000); } },
      lineas: [{ producto_id: PRODUCTO, codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 }],
      socio: { vale: true, disponible: 1000 },
      $: (id: string) => ({ value: id === 'efectivo' ? '245' : 'efectivo', style: {} }),
      exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => 500,
      totales, efectivoAlcanza, saldoCanjeable, pintar() {},
      cobrarConDolarones: async (venta: Record<string, unknown>) => {
        respuestas.push((await t.pedir('/api/ventas', { ...venta, codigo_vale: vale.codigo })).status);
        return false;
      },
    });
    await repetir();
    await repetir();
    assert.deepEqual(respuestas, [201, 200]);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 2);
    assert.equal(t.db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 48);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id = ?').get(vale.id)!.restante, 500);
  } finally { t.db.close(); }
});
