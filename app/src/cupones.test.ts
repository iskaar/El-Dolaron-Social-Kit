// node --test src/cupones.test.ts: devolver en cupón en lugar de dinero (Issue #330).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const FONDO = 50000;

async function abrir(cantidad = 2) {
  const t = tienda();
  const v = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad }], forma_pago: 'efectivo',
    efectivo: 25000 * cantidad, caja: 'Caja 1' };
  assert.equal((await t.pedir('/api/ventas', v)).status, 201);
  const linea = (await t.pedir(`/api/ventas/${v.id}`, undefined, 'GET')).cuerpo.lineas[0].id;
  const cupon = (cuerpo: Record<string, unknown>) =>
    t.pedir(`/api/ventas/${v.id}/cupon`, { id: crypto.randomUUID(), motivo: 'no le quedó', caja: 'Caja 1', ...cuerpo });
  const corte = (contado: number) =>
    t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: contado, tarjeta_terminal: 0 });
  const stock = () => t.db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock;
  return { ...t, v, linea, cupon, corte, stock };
}

test('cupón en el mismo turno: la pieza regresa, el dinero se queda en el cajón y el cupón se canjea', async () => {
  const t = await abrir();
  try {
    const r = await t.cupon({ lineas: [{ linea: t.linea, cantidad: 1 }] });
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.cupon.importe, 25000);
    assert.equal(r.cuerpo.cupon.origen, 'devolucion');
    assert.equal(t.stock(), 49);
    const ticket = (await t.pedir(`/api/ventas/${t.v.id}`, undefined, 'GET')).cuerpo;
    assert.equal(ticket.devuelto, 25000);
    assert.equal(ticket.devuelto_cupon, 25000);
    assert.equal(ticket.devoluciones[0].importe, 0);
    assert.equal(ticket.devoluciones[0].cupon, 25000);

    // El ticket ya no se cancela completo: el corte del turno no contaria el dinero del cupón.
    const completo = await t.pedir(`/api/ventas/${t.v.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(completo.status, 409);
    assert.match(completo.cuerpo.error, /pieza por pieza/);

    // El cupón paga como un vale.
    const canje = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 0, codigo_vale: r.cuerpo.cupon.codigo, dolarones: 25000, caja: 'Caja 1' });
    assert.equal(canje.status, 201, JSON.stringify(canje.cuerpo));
    assert.equal(t.db.prepare('select restante from vales_dolarones where id = ?').get(r.cuerpo.cupon.id)!.restante, 0);

    // Entraron $500 en efectivo y no salió nada: el canje no mete dinero.
    const corte = (await t.corte(FONDO + 50000)).cuerpo;
    assert.equal(corte.efectivo_ventas, 50000);
    assert.equal(corte.efectivo_devoluciones, 0);
    assert.equal(corte.diferencia, 0);
  } finally { t.db.close(); }
});

test('cupón de un ticket de un turno anterior: no sale dinero de este corte', async () => {
  const t = await abrir();
  try {
    assert.equal((await t.corte(FONDO + 50000)).cuerpo.diferencia, 0);
    assert.equal((await t.cupon({ lineas: 'todo' })).status, 201);
    assert.equal(t.stock(), 50);
    const corte = (await t.corte(FONDO)).cuerpo;
    assert.equal(corte.efectivo_devoluciones, 0);
    assert.equal(corte.diferencia, 0);
  } finally { t.db.close(); }
});

test('el porcentaje del dueño, reenvío sin duplicar y pieza ya devuelta', async () => {
  const t = await abrir();
  try {
    assert.equal((await t.pedir('/api/config', { cupon_porcentaje: 80 }, 'PUT')).status, 200);
    const id = crypto.randomUUID();
    const r = await t.cupon({ id, lineas: 'todo' });
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.cupon.importe, 40000);   // 80% de $500
    const otra = await t.cupon({ id, lineas: 'todo' });
    assert.equal(otra.cuerpo.duplicada, true);
    assert.equal(otra.cuerpo.cupon.codigo, r.cuerpo.cupon.codigo);
    assert.equal(t.db.prepare(`select count(*) as n from vales_dolarones where origen = 'devolucion'`).get()!.n, 1);
    assert.equal((await t.cupon({ lineas: 'todo' })).status, 400);   // ya no queda nada
    const reimpreso = await t.pedir(`/api/ventas/${t.v.id}/cupon/${id}`, {});
    assert.equal(reimpreso.cuerpo.codigo, r.cuerpo.cupon.codigo);
  } finally { t.db.close(); }
});

test('cupón manual: el dueño lo emite directo; un reenvío no emite dos', async () => {
  const t = tienda();
  try {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/cupones', { id, importe: 15000, motivo: 'cortesía' });
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.cupon.origen, 'manual');
    assert.equal((await t.pedir('/api/cupones', { id, importe: 15000, motivo: 'cortesía' })).cuerpo.duplicada, true);
    assert.equal((await t.pedir('/api/cupones', { id: crypto.randomUUID(), importe: 0, motivo: 'x' })).status, 400);
    const fila = t.db.prepare('select venta_id, aprobado_por, restante from vales_dolarones where id = ?').get(id)!;
    assert.equal(fila.venta_id, null);
    assert.equal(fila.restante, 15000);
  } finally { t.db.close(); }
});
