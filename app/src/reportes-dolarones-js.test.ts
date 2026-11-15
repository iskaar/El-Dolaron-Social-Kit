// node --test src/reportes-dolarones-js.test.ts
// Las funciones puras de la vista Dolarones: del JSON de la API a HTML, sin navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import {
  bandaCuadre, identidad, tarjetas, vistaDolarones, graficas, datosSerie, datosCalendario, etiquetaCubeta, tablaOrigen, efectoVenta, porcentaje, tablaSaldos,
} from '../public/reportes-dolarones.js';

async function respuesta(consulta = 'dias=7') {
  const t = tienda();
  t.env.VALES_ABIERTOS = 'si';
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const v = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 4 }], forma_pago: 'efectivo', efectivo: 100000, caja: 'Caja 1' });
  assert.equal(v.status, 201);
  await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 24000, dolarones: 1000, codigo_vale: v.cuerpo.vale_emitido.codigo, caja: 'Caja 1' });
  const r = (await t.pedir(`/api/reportes/dolarones?${consulta}`)).cuerpo;
  t.db.close();
  const otra = tienda();
  const vacia = (await otra.pedir(`/api/reportes/dolarones?${consulta}`)).cuerpo;
  otra.db.close();
  return { r, vacia };
}

test('la banda dice que cuadra con la identidad escrita, y avisa con la diferencia cuando no', async () => {
  const { r } = await respuesta();
  const html = bandaCuadre(r);
  assert.match(html, /✓ El saldo cuadra/);
  assert.match(html, /class="banda-saldo ok"/);
  assert.ok(html.includes(identidad(r.cuadre.total)));
  assert.match(identidad(r.cuadre.total), /^Emitido .* − canjeado .* − vencido .* − retirado .* = saldo vivo /);
  const roto = structuredClone(r);
  roto.cuadre.ok = false; roto.cuadre.total.diferencia = 250; roto.cuadre.socio.diferencia = 250;
  const malo = bandaCuadre(roto);
  assert.match(malo, /class="banda-saldo mal"/);
  assert.match(malo, /diferencia de 2\.50 D/);
  roto.cuadre.ok = true; roto.cuadre.total.diferencia = 0; roto.cuadre.socio.diferencia = 0; roto.tickets.diferencia = 100;
  assert.match(bandaCuadre(roto), /cuadra, pero hay algo que revisar/);
});

test('las ocho tarjetas, con cifras de la API y mensajes honestos cuando no hay con que comparar', async () => {
  const { r, vacia } = await respuesta();
  const html = tarjetas(r);
  for (const etq of ['Emitidos en el periodo', 'Canjeados', 'Tasa de canje', 'Saldo vivo', 'Por vencer en 30 días', 'Vencidos sin usar', 'Costo del programa', 'Tickets pagados con Dolarones'])
    assert.ok(html.includes(etq), etq);
  assert.equal(html.match(/class="tarjeta"/g)!.length, 8);
  assert.match(html, /Sin datos/, 'la tasa de canje no se inventa');
  assert.match(html, /Sin periodo anterior para comparar/);
  const v = tarjetas(vacia);
  assert.match(v, /0\.00 D/);
  assert.match(v, /Sin ventas netas con qué comparar/);
  assert.equal(porcentaje(1, 0), null);
  assert.equal(porcentaje(1, 4), '25.0 %');
});

test('la vista entera se arma con el programa vacio y con datos, y todo lo que escribe es texto escapado', async () => {
  const { r, vacia } = await respuesta();
  for (const x of [r, vacia]) {
    const html = vistaDolarones(x);
    for (const id of ['d-sem', 'd-vivo', 'd-origen', 'd-origen-t', 'd-vales', 'd-dias', 'd-vence', 'd-efecto', 'd-saldos']) assert.ok(html.includes(`id="${id}"`), id);
    assert.equal((html.match(/class="alterna"/g) ?? []).length, 5, 'cada grafica ofrece Ver tabla');
  }
  assert.match(vistaDolarones(vacia), /Todavía no hay movimientos del programa/);
  assert.match(vistaDolarones(vacia), /Ningún socio tiene saldo vigente/);
  assert.match(vistaDolarones(vacia), /Sin vales emitidos/);
  const sucio = structuredClone(r);
  sucio.tienda = 'salk'; sucio.tienda_nombre = '<img src=x>';
  assert.ok(!vistaDolarones(sucio).includes('<img src=x>'));
  assert.match(vistaDolarones(sucio), /de todo el negocio/);
});

test('la tabla por origen suma sus columnas hasta el total del cuadre', async () => {
  const { r } = await respuesta();
  const html = tablaOrigen(r);
  assert.match(html, /<td>Total<\/td>/);
  assert.equal(html.match(/<tr>/g)!.length, r.por_origen.length + 2, 'encabezado, un renglon por origen y el total');
  assert.ok(!html.includes('Traspaso'), 'sin traspasos la columna no sale');
  const conTraspaso = structuredClone(r);
  conTraspaso.por_origen[0].traspaso = -1000;
  assert.match(tablaOrigen(conTraspaso), /Traspaso/);
});

test('las graficas salen de los datos y cada serie coincide con su tabla', async () => {
  const { r, vacia } = await respuesta('dias=10');
  const d = datosSerie(r);
  assert.equal(d.categorias.length, 10);
  assert.equal(d.series[0].valores.reduce((a: number, b: number) => a + b, 0), r.periodo.emitidos);
  const g = graficas(r, () => 640);
  assert.deepEqual(Object.keys(g).sort(), ['calendario', 'dias', 'origen', 'semana', 'vivo']);
  for (const svg of Object.values(g)) { assert.match(svg as string, /^<svg /); assert.ok(!(svg as string).includes('NaN')); }
  const cal = datosCalendario(r);
  assert.equal(cal.categorias.length, 9, 'ocho semanas y «despues»');
  assert.equal(cal.series.flatMap((s: { valores: number[] }) => s.valores).reduce((a: number, b: number) => a + b, 0), r.saldo.vivo);
  // Sin datos tampoco hay NaN ni graficas rotas.
  for (const svg of Object.values(graficas(vacia, () => 300))) assert.ok(!(svg as string).includes('NaN'));
  assert.deepEqual(etiquetaCubeta({ desde: '2026-11-09', hasta: '2026-11-15', parcial: false }), { etiqueta: '9–15 nov', titulo: '9 nov – 15 nov 2026' });
  assert.match(etiquetaCubeta({ desde: '2026-10-28', hasta: '2026-11-01', parcial: true }).titulo, /parcial/);
});

test('efecto en la venta y saldos: dinero por D canjeado y solo numeros de socio', () => {
  const r = { efecto: { tickets: 10, con: { tickets: 4, neto: 100000, dolarones: 10000, dinero: 90000 }, sin: { tickets: 6, neto: 60000 } },
    saldos: [{ socio: 12, saldo: 5000, disponible: 3000, por_liberar: 2000, vence_primero: '2026-12-31', ultima_compra: null }] };
  const html = efectoVenta(r);
  assert.match(html, /\$250\.00/);      // ticket promedio con D
  assert.match(html, /\$100\.00/);      // sin D
  assert.match(html, /\$9\.00/);        // $900 de dinero entre 100 D = $9 por D
  assert.match(efectoVenta({ efecto: { tickets: 0, con: { tickets: 0, neto: 0, dolarones: 0, dinero: 0 }, sin: { tickets: 0, neto: 0 } } }), /Sin tickets/);
  const tabla = tablaSaldos(r);
  assert.match(tabla, /Socio #12/);
  assert.match(tabla, /Sin compras/);
});
