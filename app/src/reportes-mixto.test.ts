// node --test src/reportes-mixto.test.ts
// Pago mixto en los reportes (Issue #956, PR B): un ticket mixto se reparte en efectivo y tarjeta; nunca aparece una forma «mixto».
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { lineasNetas } from './netas.ts';
import { verificarCuadre } from '../public/graficas.js';
import { CLAVE_COMISION } from '../public/reportes-finanzas.js';
import { vista } from './tablero-prueba.ts';

type T = ReturnType<typeof tienda>;
type Forma = { forma_pago: string; tickets: number; total: number };

/** Un ticket de `piezas` ventiladores ($250 c/u) con `efectivo` en efectivo y el resto con tarjeta. */
async function mixta(t: T, piezas: number, efectivo: number) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'mixto', efectivo, caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return id;
}
async function efectivo(t: T, piezas = 1) {
  const r = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1' });
  assert.equal(r.status, 201);
}
const devolver = async (t: T, id: string) => {
  const linea = (await t.pedir(`/api/ventas/${id}`)).cuerpo.lineas[0].id;
  const r = await t.pedir(`/api/ventas/${id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
};
const reporte = async (t: T) => (await t.pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo;
const forma = (formas: Forma[], clave: string) => formas.find((f) => f.forma_pago === clave);

test('un ticket mixto da una fila de efectivo y una de tarjeta con sus partes; no hay fila mixto y todo cuadra', async () => {
  const t = tienda();
  await mixta(t, 1, 10000);        // $100 efectivo + $150 tarjeta
  await efectivo(t);               // $250 efectivo
  const r = await reporte(t);
  const formas = r.por_forma_pago as Forma[];
  assert.equal(forma(formas, 'mixto'), undefined);
  assert.deepEqual({ ...forma(formas, 'efectivo') }, { forma_pago: 'efectivo', tickets: 2, total: 35000 });
  assert.deepEqual({ ...forma(formas, 'tarjeta') }, { forma_pago: 'tarjeta', tickets: 1, total: 15000 });
  assert.equal(r.resumen.total, 50000);
  assert.equal(formas.reduce((s, f) => s + f.total, 0), 50000);
  assert.ok(verificarCuadre(r).every((c: { ok: boolean }) => c.ok));
});

test('el reparto por pieza suma exacto la parte en tarjeta de cada ticket (centavos que no dividen parejo)', async () => {
  const t = tienda();
  const gorra = crypto.randomUUID();
  t.db.prepare("insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, 'ED-000002', 'Gorra', 3333, 50, 'S40', '', '')").run(gorra);
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', {
    id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: gorra, cantidad: 1 }, { producto_id: gorra, cantidad: 2 }],
    forma_pago: 'mixto', efectivo: 12345, caja: 'Caja 1',
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const { total } = r.cuerpo;
  const filas = t.db.prepare(`${lineasNetas('v.id = ?')} select cobrado, tarjeta_linea, neta from cobros`).all(id) as { cobrado: number; tarjeta_linea: number; neta: number }[];
  assert.ok(filas.length >= 3);
  assert.equal(filas.reduce((s, f) => s + f.tarjeta_linea, 0), total - 12345);
  assert.equal(filas.reduce((s, f) => s + f.cobrado, 0), total);
  assert.ok(filas.every((f) => Number.isInteger(f.tarjeta_linea) && f.tarjeta_linea > 0));
  const formas = (await reporte(t)).por_forma_pago as Forma[];
  assert.deepEqual([forma(formas, 'efectivo')?.total, forma(formas, 'tarjeta')?.total], [12345, total - 12345]);
});

test('un mixto con una pieza devuelta: la devolucion sale del efectivo, la tarjeta se queda y el total sigue siendo lo cobrado', async () => {
  const t = tienda();
  const id = await mixta(t, 3, 30000);     // $750: $300 efectivo + $450 tarjeta
  await devolver(t, id);                   // $250 en efectivo
  const r = await reporte(t);
  const formas = r.por_forma_pago as Forma[];
  assert.equal(forma(formas, 'mixto'), undefined);
  assert.equal(forma(formas, 'tarjeta')?.total, 45000);
  assert.equal(forma(formas, 'efectivo')?.total, 5000);   // 30000 - 25000
  assert.equal(r.resumen.total, 50000);
  assert.equal(formas.reduce((s, f) => s + f.total, 0), 50000);
  assert.ok(verificarCuadre(r).every((c: { ok: boolean }) => c.ok));
});

test('finanzas: la comision de la terminal cuenta la parte en tarjeta del mixto y las formas del dia suman lo cobrado', async () => {
  const t = tienda();
  await mixta(t, 1, 10000);                // tarjeta $150
  const hoy = hoyTienda();
  assert.equal((await t.pedir('/api/config', { [CLAVE_COMISION]: 400 }, 'PUT')).status, 200);
  const f = (await t.pedir(`/api/reportes/finanzas?desde=${hoy}&hasta=${hoy}`, undefined, 'GET')).cuerpo;
  assert.equal(f.terminal.tarjeta, 15000);
  assert.equal(f.terminal.comision, 600);   // $150.00 x 4 %
  const v = (await t.pedir(`/api/reportes/ventas?desde=${hoy}&hasta=${hoy}`, undefined, 'GET')).cuerpo;
  assert.doesNotMatch(JSON.stringify(v), /mixto/);
});

test('tablero (tienda): el mixto se reparte en efectivo y tarjeta, sin duplicar tickets ni total y sin caer en otras', async () => {
  const t = tienda();
  await mixta(t, 1, 10000);
  await efectivo(t);
  const d = (await vista(t, 'tienda')).cuerpo;
  assert.equal(d.tienda.total, 50000);
  assert.equal(d.tienda.tickets, 2);
  assert.deepEqual({ ...d.pagos }, { efectivo: 35000, tarjeta: 15000, transferencia: 0, dolarones: null, otras: 0 });
});
