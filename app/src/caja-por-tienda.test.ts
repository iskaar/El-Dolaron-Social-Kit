// node --test src/caja-por-tienda.test.ts
// #912: en /caja cada tienda ve solo sus ventas («Ventas de hoy», contador del día y búsqueda de devolución).
// El folio del ticket sigue encontrando el de otra tienda (R3 de #793: se devuelve en una tienda lo comprado en otra).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

const DUENO_SALK = 'duenosalk@prueba.mx';

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, 'Dueño Salk', 'dueno', 1, 'salk', '', '')`)
    .run(DUENO_SALK);
  t.db.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 10, '')`).run(PRODUCTO);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  // Mismas piezas en las dos tiendas: la misma etiqueta se vende en Soledad (2) y en Salk (1).
  const vender = async (correo: string, caja: string, cantidad: number) => {
    como(correo);
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad }], forma_pago: 'efectivo', efectivo: 100000, caja });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return id;
  };
  const soledad = await vender(DUENO, 'Caja 1', 2);
  const salk = await vender(DUENO_SALK, 'Salk 1', 1);
  const leer = async (correo: string, ruta: string) => { como(correo); const r = await t.pedir(ruta); assert.equal(r.status, 200, ruta); return r.cuerpo as any; };
  const ids = (filas: { id: string }[]) => filas.map((f) => f.id);
  return { ...t, soledad, salk, leer, ids };
}

test('«Ventas de hoy»: cada sesión recibe solo los tickets de su tienda', async () => {
  const { soledad, salk, leer, ids } = await montar();
  assert.deepEqual(ids(await leer(DUENO, '/api/ventas?lista=1')), [soledad]);
  assert.deepEqual(ids(await leer(DUENO_SALK, '/api/ventas?lista=1')), [salk]);
});

test('el contador del día («Hoy: N ventas · M piezas») suma solo la tienda de la sesión', async () => {
  const { leer } = await montar();
  const cuenta = (c: { piezas: number; por_forma_pago: { tickets: number }[] }) => [c.por_forma_pago.reduce((s, f) => s + f.tickets, 0), c.piezas];
  assert.deepEqual(cuenta(await leer(DUENO, '/api/ventas')), [1, 2]);
  assert.deepEqual(cuenta(await leer(DUENO_SALK, '/api/ventas')), [1, 1]);
});

test('devolución: por pieza, UPC o nombre solo la tienda de la sesión; por folio también el ticket de otra tienda', async () => {
  const { soledad, salk, leer, ids } = await montar();
  for (const q of ['ED-000001', 'ventilador']) {
    assert.deepEqual(ids(await leer(DUENO, `/api/ventas?buscar=${q}`)), [soledad], q);
    assert.deepEqual(ids(await leer(DUENO_SALK, `/api/ventas?buscar=${q}`)), [salk], q);
  }
  // El folio completo o su inicio (>= 8 caracteres) cruza tiendas, como hoy.
  assert.deepEqual(ids(await leer(DUENO_SALK, `/api/ventas?buscar=${soledad}`)), [soledad]);
  assert.deepEqual(ids(await leer(DUENO, `/api/ventas?buscar=${salk.slice(0, 8)}`)), [salk]);
  // Y el detalle por id no cambia.
  assert.equal((await leer(DUENO_SALK, `/api/ventas/${soledad}`)).id, soledad);
});
