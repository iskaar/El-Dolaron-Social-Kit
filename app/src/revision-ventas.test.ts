// node --test src/revision-ventas.test.ts
// Errores de la revision del 7/10 en el camino del dinero: cada prueba falla sin su correccion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, promoInauguracion } from '../public/venta.js';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const fuente = readFileSync('public/caja.html', 'utf8');
const venta = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(),
  lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'tarjeta', efectivo: 0, caja: 'Caja 1', ...extra });

test('una hora de la caja en el futuro no se guarda: la venta cae en el dia y el corte reales', async () => {
  const t = tienda();
  try {
    const futura = venta({ creado_en: '2099-01-01T12:00:00.000Z' });
    const basura = venta({ creado_en: 'ayer' });
    const offline = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const vieja = venta({ creado_en: offline });
    for (const v of [futura, basura, vieja]) assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    const hora = (id: string) => (t.db.prepare('select creado_en from ventas where id = ?').get(id) as { creado_en: string }).creado_en;
    assert.ok(Date.parse(hora(futura.id)) <= Date.now(), hora(futura.id));
    assert.ok(Date.parse(hora(basura.id)) <= Date.now(), hora(basura.id));
    assert.equal(hora(vieja.id), offline);   // una venta sin red conserva su hora
    // Un reintento de la futura sigue siendo la misma venta.
    assert.equal((await t.pedir('/api/ventas', futura)).cuerpo.duplicada, true);
  } finally { t.db.close(); }
});

test('la promo del ticket nuevo se mide con la hora de ahora, no con la hora de la venta anterior', () => {
  const inicio = '2026-10-07T16:00:00.000Z';
  const ahora = Date.parse('2026-10-07T20:00:00.000Z');
  const linea = fuente.slice(fuente.indexOf('const promoActual ='), fuente.indexOf('\n', fuente.indexOf('const promoActual =')));
  const caja = runInNewContext(`let idVenta = null, creadoEnVenta = null;\n${linea}; ({ promoActual, fijar(i, c) { idVenta = i; creadoEnVenta = c; } })`, {
    totales, promoInauguracion, lineas: [{ precio: 40000, cantidad: 1 }], promoConfig: { desde: inicio, hasta: '2026-10-14T16:00:00.000Z' },
    Date: class extends Date { static now() { return ahora; } },
  });
  // La venta anterior se cobro a las 10:00, antes de que empezara la promo; ya no hay ticket en curso.
  caja.fijar(null, '2026-10-07T10:00:00.000Z');
  assert.equal(caja.promoActual(), 10000);
  // Un reintento del mismo ticket (mismo folio) si conserva su hora.
  caja.fijar(crypto.randomUUID(), '2026-10-07T10:00:00.000Z');
  assert.equal(caja.promoActual(), 0);
});

test('sincronizar deja encolada la venta si la respuesta no es del servidor o la sesion caduco', async () => {
  const texto = fuente.slice(fuente.indexOf('let sincronizando = false;'), fuente.indexOf('async function pendientes()'));
  const intentar = async (respuesta: { status: number; json: () => Promise<unknown> }) => {
    const v = venta();
    const cola = new Map<string, any>([[v.id, v]]);
    const sincronizar = runInNewContext(`${texto}; sincronizar`, {
      store: async (almacen: string, _modo: string, fn: any) => fn({
        getAll: () => almacen === 'ventas' ? [...cola.values()] : [],
        delete: (id: string) => cola.delete(id),
        put: (x: any) => cola.set(x.id, x),
      }),
      fetch: async () => respuesta, $: () => ({ textContent: '' }), dolares: String, AbortSignal,
      pintarResultadosVales() {}, pendientes() {}, pintarRechazadas() {}, actualizarCorte() {},
    });
    await sincronizar();
    return cola.get(v.id);
  };
  // Portal cautivo o proxy: 200 con HTML. No es una venta registrada.
  const html = await intentar({ status: 200, json: async () => { throw new SyntaxError('no es JSON'); } });
  assert.ok(html && html.estado === undefined);
  // Sesion o PIN caducados: se reintenta solo al volver a entrar, no queda como rechazada.
  const sinSesion = await intentar({ status: 401, json: async () => ({ error: 'Escribe tu PIN de cajero.', pin: true }) });
  assert.ok(sinSesion && sinSesion.estado === undefined);
  // Un rechazo de verdad del servidor si se muestra aparte.
  const rechazo = await intentar({ status: 409, json: async () => ({ error: 'No hay existencia suficiente.' }) });
  assert.equal(rechazo.estado, 'rechazada');
});

test('un rango de dias ilegible en reportes cae al de 30 dias en vez de tronar', async () => {
  const t = tienda();
  try {
    for (const ruta of ['/api/reportes?dias=abc', '/api/reportes/tickets?dias=abc']) {
      const r = await t.pedir(ruta, undefined, 'GET');
      assert.equal(r.status, 200, ruta);
    }
    assert.equal((await t.pedir('/api/reportes?dias=abc', undefined, 'GET')).cuerpo.dias, 30);
  } finally { t.db.close(); }
});
