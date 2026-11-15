// node --test src/reportes-inventario-js.test.ts
// Las funciones puras de la vista Inventario: del JSON de la API a HTML, sin navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import {
  tarjetasInventario, avisoTienda, tablaCohortes, leyendaCohortes, maximoCohortes, panelFlujo, panelCohortes, panelRebajas, vistaInventario, graficas,
  datosFlujo, tablaFlujo, resumenFlujo, textoMediana, comparacionRebajas,
} from '../public/reportes-inventario.js';

const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

async function respuestas() {
  const t = tienda();
  const pieza = (dias: number, stock: number) => {
    const id = crypto.randomUUID();
    t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, estado_analisis, categoria)
      values (?, ?, 'Pieza <b>de prueba</b>', 30000, ?, 'S40', ?, ?, 'listo', 'hogar')`).run(id, `ED-8${Math.floor(Math.random() * 1e5)}`, stock, hace(dias), hace(dias));
    return id;
  };
  const vender = async (id: string, dias: number) => {
    const v = crypto.randomUUID();
    assert.equal((await t.pedir('/api/ventas', { id: v, lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 30000, caja: 'Caja 1' })).status, 201);
    t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace(dias), hace(dias), v);
  };
  const A = pieza(50, 4), B = pieza(30, 3), C = pieza(8, 2);
  await vender(A, 47); await vender(A, 20); await vender(B, 25); await vender(C, 3);
  t.db.prepare('update productos set precio = 20000, modificado_por = ? where id = ?').run('dueno@x.mx', B);
  t.db.prepare('update productos_cambios set en = ? where campo = ?').run(hace(5), 'precio');
  const r = (await t.pedir('/api/reportes/inventario?dias=28')).cuerpo;
  const base = (await t.pedir('/api/reportes?dias=28')).cuerpo;
  t.db.close();
  const otra = tienda();
  const vacia = (await otra.pedir('/api/reportes/inventario?dias=7')).cuerpo;
  const baseVacia = (await otra.pedir('/api/reportes?dias=7')).cuerpo;
  otra.db.close();
  return { r, base, vacia, baseVacia };
}

test('las seis tarjetas: lo de piso es foto de hoy, sin minigrafica ni «vs antes»; lo del periodo dice con que se compara', async () => {
  const { r, base, vacia, baseVacia } = await respuestas();
  const html = tarjetasInventario(r, base);
  for (const etq of ['Valor en piso', 'Piezas en piso', 'Antigüedad promedio', 'Vendido a 4 semanas', 'Días en venta', 'Merma por caducidad']) assert.ok(html.includes(etq), etq);
  assert.equal(html.match(/class="tarjeta kpi"/g)!.length, 6, 'el mismo marcado que las tarjetas de Resumen');
  assert.equal(html.match(/Foto de hoy/g)!.length, 3);
  assert.match(html, /Foto de hoy: no hay historial para comparar/);
  assert.ok(html.includes('Mediana de captura a venta'));
  assert.equal(html.match(/<svg class="mini /g)?.length ?? 0, 0, 'una sola cohorte madura: no hay tendencia que dibujar');
  const vacio = tarjetasInventario(vacia, baseVacia);
  assert.match(vacio, /Sin datos/);
  assert.match(vacio, /Ninguna semana de captura tiene aún 4 semanas/);
  assert.match(vacio, /Sin ventas con fecha de captura en el periodo/);
  assert.match(tarjetasInventario(null, base), /Cargando/, 'mientras llega la peticion nueva, lo demas ya se ve');
  assert.match(tarjetasInventario(r, null), /—/);
});

test('con dos cohortes maduras el vendido a 4 semanas lleva su minigrafica', () => {
  const semana = (p: number) => ({ lunes: '2026-10-05', domingo: '2026-10-11', piezas: 1, unidades: 10, vendidas: 5, existencia: 5, apartadas: 0, sin_venta: 0, pct: { 1: p, 2: p, 4: p, 8: null }, vendidas_en: { 1: 1, 2: 1, 4: 1, 8: null } });
  const r = { cohortes: { semanas: [semana(10), semana(30)], vendido_4: { pct: 20, unidades: 20, vendidas: 4, semanas: 2 } }, dias_en_venta: { mediana: 12, mediana_antes: 15, unidades: 9, unidades_antes: 8, tramos: [] } };
  const html = tarjetasInventario(r, null);
  assert.equal(html.match(/<svg class="mini /g)!.length, 1);
  assert.match(html, /20\.0 %/);
  assert.match(html, /▼ −20\.0%/, 'los dias en venta bajaron: flecha y texto');
  assert.match(html, /vs periodo anterior/);
});

test('el aviso de tienda dice que la vista no se filtra', () => {
  assert.match(avisoTienda(''), /negocio completo/);
  const con = avisoTienda('Avenida Salk');
  assert.match(con, /Con Avenida Salk elegida esta vista no cambia/);
  assert.match(con, /Dónde está el inventario/);
});

test('la tabla de cohortes: guion donde no ha madurado, 0.0 % donde si y nada se inventa', async () => {
  const { r, vacia } = await respuestas();
  const html = tablaCohortes(r);
  assert.match(html, /<td class="num sin"[^>]*>—<\/td>/, 'las semanas inmaduras son guion');
  assert.equal(html.includes('0.0 %'), false);
  assert.match(html, /Aún no pasan 8 semanas desde que cerró la semana/);
  assert.match(html, /class="num p\d"/);
  assert.equal((html.match(/<tr>/g)!.length) - 1 >= 8, true, 'al menos ocho semanas de captura');
  assert.equal(tablaCohortes(vacia).includes('Sin capturas esa semana'), true);
  const cero = structuredClone(r);
  const semana = cero.cohortes.semanas.find((s: any) => s.unidades > 0);
  semana.pct = { 1: 0, 2: 0, 4: 0, 8: 0 }; semana.vendidas_en = { 1: 0, 2: 0, 4: 0, 8: 0 };
  assert.match(tablaCohortes(cero), /class="num cero"[^>]*>0\.0 %/, 'una cohorte madura sin ventas si es 0 %');
  assert.equal(maximoCohortes(vacia), 0);
  assert.equal(leyendaCohortes(vacia), '');
  assert.match(leyendaCohortes(r), /hasta \d/);
});

test('entradas y salidas: columnas con la tabla como respaldo, neto con flecha y texto', async () => {
  const { r, vacia } = await respuestas();
  const d = datosFlujo(r);
  assert.deepEqual(d.series.map((s: any) => s.nombre), ['Capturadas', 'Vendidas']);
  assert.equal(d.categorias.length, r.flujo.semanas.length);
  const tabla = tablaFlujo(r);
  assert.match(tabla, /Total/);
  assert.match(tabla, /De ellas, Mercado Libre/);
  const panel = panelFlujo(r);
  assert.match(panel, /data-grafica="flujo"/);
  assert.match(panel, /Ver tabla/);
  assert.match(resumenFlujo(r), /neto [▲▼=]/);
  assert.match(resumenFlujo(vacia), /Sin capturas ni ventas/);
  const g = graficas(r, () => 640);
  assert.match(g.flujo, /<svg/);
  assert.match(graficas(vacia, () => 640).flujo, /Sin capturas ni ventas/);
  assert.doesNotThrow(() => graficas(vacia, (id: string) => (id === 'flujo' ? 640 : 0)), 'un hueco ausente (sin rebajas) da ancho 0 y no rompe nada');
  assert.match(g.rebajas, /<svg/);
});

test('los paneles escriben texto escapado y dicen lo que cuentan', async () => {
  const { r, vacia } = await respuestas();
  const todo = JSON.stringify(vistaInventario(r)) + panelCohortes(r);
  assert.equal(todo.includes('<b>de prueba</b>'), false);
  assert.match(panelCohortes(r), /La cantidad inicial de una pieza no se guarda/);
  assert.match(panelCohortes(r), /Salieron sin venta/);
  assert.match(panelCohortes(r), /al menos las últimas 8 semanas/);
  assert.equal(panelCohortes({ ...r, dias: 120 }).includes('al menos las últimas 8 semanas'), false);
  assert.match(textoMediana(r), /Mediana del periodo/);
  assert.match(textoMediana(vacia), /Sin piezas vendidas/);
  const v = vistaInventario(vacia);
  assert.deepEqual(Object.keys(v), ['flujo', 'cohortes', 'rebajas']);
});

test('rebajas: sin bitacora, sin rebajas, con muestra chica y con comparacion', async () => {
  const { r, vacia } = await respuestas();
  assert.match(panelRebajas(vacia), /todavía no hay registro de cambios/);
  assert.match(panelRebajas(vacia), /Sin datos/);
  const con = panelRebajas(r);
  assert.match(con, /desde el \d+ \w+, cuando empezó el registro/);
  assert.match(con, /Ver tabla/);
  assert.match(con, /data-grafica="rebajas"/);
  assert.match(con, /Es una comparación, no una prueba/);
  assert.match(con, /¿Se vende más después de rebajar\?/);

  const sinRebajas = structuredClone(r);
  sinRebajas.rebajas.total = { eventos: 0, piezas: 0, pct_promedio: null };
  const html = panelRebajas(sinRebajas);
  assert.match(html, /Sin rebajas en el periodo/);
  assert.equal(html.includes('data-grafica="rebajas"'), false, 'sin rebajas no hay grafica vacia');

  const cmp = structuredClone(r);
  cmp.rebajas.comparacion = {
    ventana_dias: 14, edades: [14, 28, 49, 70], poca_muestra: true,
    tramos: [{ tramo: 0, rebajadas: { piezas: 2, pendientes: 10, vendidas: 5, pct: 50 }, sin_rebaja: { piezas: 9, pendientes: 40, vendidas: 8, pct: 20 } },
      { tramo: 1, rebajadas: { piezas: 0, pendientes: 0, vendidas: 0, pct: null }, sin_rebaja: { piezas: 0, pendientes: 0, vendidas: 0, pct: null } }],
    rebajadas: { piezas: 2, pendientes: 10, vendidas: 5 },
    comparables: { pendientes: 10, vendidas: 5, pct: 50, pct_sin_rebaja: 20, diferencia_pp: 30 },
  };
  const texto = comparacionRebajas(cmp);
  assert.match(texto, /50\.0 % se vendió en 14 días/);
  assert.match(texto, /▲ \+30\.0 puntos/);
  assert.match(texto, /Muestra chica/);
  assert.match(texto, /0–2 semanas/);
  assert.equal(texto.includes('3–4 semanas'), false, 'un tramo sin piezas no ocupa fila');
  cmp.rebajas.comparacion.comparables = { pendientes: 0, vendidas: 0, pct: null, pct_sin_rebaja: null, diferencia_pp: null };
  assert.match(comparacionRebajas(cmp), /Ningún tramo de antigüedad tiene a la vez/);
  const ninguna = structuredClone(r);
  ninguna.rebajas.comparacion.rebajadas.piezas = 0;
  assert.match(comparacionRebajas(ninguna), /todavía no se puede medir/);
});
