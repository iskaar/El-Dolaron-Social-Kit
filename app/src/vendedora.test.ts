// node --test src/vendedora.test.ts
// Quien atendio la venta (#750): `ventas.vendedora` junto a `cajero`, validada en el servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const usuario = (t: ReturnType<typeof tienda>, correo: string, roles: string, activo = 1) =>
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, ?, '', '')`)
    .run(correo, correo.split('@')[0], roles, activo);
const venta = (extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, ...extra });

test('la venta guarda quien atendió, distinta de quien cobra, y /api/ventas la devuelve', async () => {
  const t = tienda();
  try {
    usuario(t, 'sofia@prueba.mx', 'capturista');
    const v = venta({ vendedora: 'sofia@prueba.mx' });
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    const fila = t.db.prepare('select cajero, vendedora from ventas where id = ?').get(v.id)!;
    assert.notEqual(fila.cajero, 'sofia@prueba.mx');
    assert.equal(fila.vendedora, 'sofia@prueba.mx');
    const lista = (await t.pedir('/api/reportes/tickets?dias=1')).cuerpo.tickets;
    assert.equal(lista.find((x: { id: string }) => x.id === v.id).vendedora, 'sofia@prueba.mx');
  } finally { t.db.close(); }
});

test('vendedora inválida: inexistente, inactiva, sin rol de piso o no texto → 400 y no se vende', async () => {
  const t = tienda();
  try {
    usuario(t, 'baja@prueba.mx', 'cajero', 0);
    usuario(t, 'rev@prueba.mx', 'revendedora');
    usuario(t, 'compu@prueba.mx', 'computadora');
    for (const vendedora of ['nadie@prueba.mx', 'baja@prueba.mx', 'rev@prueba.mx', 'compu@prueba.mx', 7]) {
      assert.equal((await t.pedir('/api/ventas', venta({ vendedora }))).status, 400, String(vendedora));
    }
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  } finally { t.db.close(); }
});

test('sin vendedora el hash no cambia y el reintento vale; la lista de vendedoras trae solo cajero y capturista activos', async () => {
  const t = tienda();
  try {
    usuario(t, 'sofia@prueba.mx', 'capturista');
    usuario(t, 'rev@prueba.mx', 'revendedora');
    const v = venta();
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    const hash = t.db.prepare('select pedido_hash from ventas where id = ?').get(v.id)!.pedido_hash;
    assert.equal((await t.pedir('/api/ventas', { ...v, vendedora: '' })).cuerpo.duplicada, true);
    assert.equal(t.db.prepare('select pedido_hash, vendedora from ventas where id = ?').get(v.id)!.pedido_hash, hash);
    assert.equal(t.db.prepare('select vendedora from ventas where id = ?').get(v.id)!.vendedora, '');
    const correos = (await t.pedir('/api/vendedoras')).cuerpo.map((u: { correo: string }) => u.correo);
    assert.ok(correos.includes('sofia@prueba.mx') && !correos.includes('rev@prueba.mx'));
  } finally { t.db.close(); }
});
