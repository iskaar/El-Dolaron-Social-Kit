// node --test src/graficas.test.ts
// Dinero al centavo, escalas y cuadre de /reportes (Issue #166): lo que no toca el DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pesos, dolarones, pesosEje, pesosConSigno, cambio, rellenarDias, textoPeriodo, verificarCuadre,
  PASOS_CALOR, pasoCalor, pasosDeLaEscala, horasConVentas, textoHora, rangoHora, mapaCalor, mapaCalorHtml, tablaCalor,
  TRAMOS_ANTIGUEDAD, tramoDeDias, pasoOrdinal, flechaCambio, fechaHora, FECHAS_TICKET, barrasHorizontales, apilada, minigrafica, graficaTiempo, escalaNumero, columnas, lineaSerie, leyendaSeries,
} from '../public/graficas.js';
import { rangoDias } from './worker.ts';

test('pesos siempre lleva centavos, sin pasar por decimales', () => {
  assert.equal(pesos(0), '$0.00');
  assert.equal(pesos(5), '$0.05');
  assert.equal(pesos(99), '$0.99');
  assert.equal(pesos(100), '$1.00');
  assert.equal(pesos(123456), '$1,234.56');
  assert.equal(pesos(-50), '−$0.50');
  assert.equal(pesos(1_000_000_001), '$10,000,000.01');
  assert.equal(pesosConSigno(1550), '+$15.50');
  assert.equal(pesosConSigno(-1550), '−$15.50');
  assert.equal(pesosConSigno(0), '$0.00');
  assert.equal(dolarones(12050), '120.50 D');
  assert.equal(pesosEje(250000), '$2,500');
});

test('escalaNumero con `dinero` da marcas redondas en pesos que cubren el maximo', () => {
  assert.deepEqual(escalaNumero(0, { dinero: true }).marcas, [0, 25, 50, 75, 100]);   // sin ventas: de $0 a $1
  const e = escalaNumero(123_456, { dinero: true });                 // $1,234.56
  assert.ok(e.tope >= 123_456);
  assert.equal(e.marcas[0], 0);
  const pasos = e.marcas.slice(1).map((m, i) => m - e.marcas[i]);
  assert.ok(pasos.every((p) => p === pasos[0]), 'pasos iguales');
  assert.ok([1, 2, 2.5, 5].includes(pasos[0] / 100 / 10 ** Math.floor(Math.log10(pasos[0] / 100))), 'paso redondo');
  assert.equal(escalaNumero(100_000, { dinero: true }).tope, 100_000);   // $1,000 exacto: no se pasa de largo
});

test('cambio contra el periodo anterior', () => {
  assert.equal(cambio(100, 0), null);
  assert.deepEqual(cambio(112_30, 100_00), { pct: 12.3, direccion: 'sube', texto: '+12.3%' });
  assert.equal(cambio(50, 100)?.texto, '−50.0%');
  assert.equal(cambio(100, 100)?.direccion, 'igual');
});

test('rellenarDias pone ceros en los dias sin ventas, incluso cruzando de mes', () => {
  const dias = rellenarDias([{ dia: '2026-10-01', total: 500, tickets: 1, piezas: 2 }], '2026-09-29', '2026-10-02');
  assert.deepEqual(dias.map((d) => d.dia), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(dias.map((d) => d.total), [0, 0, 500, 0]);
  assert.match(textoPeriodo('2026-09-27', '2026-10-04'), /2026$/);
});

test('textoPeriodo (#802 A3): el año al final si no cruza; en los dos extremos si cruza de año', () => {
  assert.equal(textoPeriodo('2026-09-27', '2026-10-04'), '27 sep – 4 oct 2026');
  assert.equal(textoPeriodo('2026-11-15', '2026-11-15'), '15 nov 2026');
  assert.equal(textoPeriodo('2025-11-15', '2026-11-15'), '15 nov 2025 – 15 nov 2026');
  assert.equal(textoPeriodo('2025-12-29', '2026-01-04'), '29 dic 2025 – 4 ene 2026');
});

test('rangoDias: dias completos de la tienda (UTC-6) y el periodo anterior de igual largo', () => {
  // 4/oct 22:00 hora de la tienda = 5/oct 04:00 UTC: sigue siendo 4 de octubre.
  const r = rangoDias(7, Date.parse('2026-10-05T04:00:00Z'));
  assert.equal(r.dia_hasta, '2026-10-04');
  assert.equal(r.dia_desde, '2026-09-28');
  assert.equal(r.desde, '2026-09-28T06:00:00.000Z');
  assert.equal(r.anterior_desde, '2026-09-21T06:00:00.000Z');
  // 00:30 de la tienda del 5/oct (06:30 UTC) ya es otro dia.
  assert.equal(rangoDias(1, Date.parse('2026-10-05T06:30:00Z')).desde, '2026-10-05T06:00:00.000Z');
});

const reporte = (extra = {}) => ({
  resumen: { total: 10_000 },
  cuadre: { bruto: 13_000, devoluciones_pieza: 1_000, cancelados: 2_000, vendido: 10_000 },
  por_dia: [{ total: 6_000 }, { total: 4_000 }],
  por_hora: [{ total: 3_000 }, { total: 3_000 }, { total: 4_000 }],
  por_forma_pago: [{ total: 7_000 }, { total: 2_000 }, { total: 1_000 }],
  por_categoria: [{ total: 9_000 }, { total: 1_000 }],
  ...extra,
});

test('verificarCuadre: todo suma lo mismo, o muestra la diferencia en centavos', () => {
  assert.ok(verificarCuadre(reporte()).every((c) => c.ok));
  const mal = verificarCuadre(reporte({ por_categoria: [{ total: 9_000 }, { total: 1_001 }] }));
  const categoria = mal.find((c) => c.nombre === 'Suma de las categorías')!;
  assert.equal(categoria.ok, false);
  assert.equal(categoria.diferencia, 1);
  assert.equal(mal.filter((c) => !c.ok).length, 1);
  const hora = verificarCuadre(reporte({ por_hora: [{ total: 9_999 }] })).find((c) => c.nombre === 'Suma por hora')!;
  assert.equal(hora.ok, false);
  assert.equal(hora.diferencia, -1);
});

test('mapa de calor: el paso de cada celda en la escala, de 1 a 6, y 0 si no hay ventas', () => {
  assert.equal(PASOS_CALOR, 6);
  assert.equal(pasoCalor(0, 10_000), 0);
  assert.equal(pasoCalor(1, 10_000), 1);                // lo minimo que se vendio ya se pinta
  assert.equal(pasoCalor(1_666, 10_000), 1);
  assert.equal(pasoCalor(1_667, 10_000), 2);
  assert.equal(pasoCalor(5_000, 10_000), 3);
  assert.equal(pasoCalor(10_000, 10_000), 6);           // el maximo cae en el ultimo paso
  assert.equal(pasoCalor(500, 0), 0);                   // sin maximo no hay escala
  const escalon = pasosDeLaEscala(120_000);
  assert.deepEqual(escalon.map((p) => p.hasta), [20_000, 40_000, 60_000, 80_000, 100_000, 120_000]);
  assert.ok(escalon.every((p) => pasoCalor(p.hasta, 120_000) === p.paso), 'cada tope cae en su propio paso');
});

test('mapa de calor: horas con ventas, etiquetas y semana de lunes a domingo', () => {
  assert.deepEqual(horasConVentas([]), { desde: 9, hasta: 21 });
  assert.deepEqual(horasConVentas([{ hora: 13, tickets: 2 }, { hora: 11, tickets: 1 }, { hora: 17, tickets: 4 }]), { desde: 11, hasta: 17 });
  assert.equal(textoHora(9), '09:00');
  assert.equal(rangoHora(14), '14:00–15:00');
  assert.equal(rangoHora(23), '23:00–00:00');

  const mapa = mapaCalor([
    { dia_semana: 2, hora: 14, tickets: 5, total: 123_456 },   // martes
    { dia_semana: 0, hora: 12, tickets: 1, total: 25_000 },    // domingo
    { dia_semana: 6, hora: 16, tickets: 3, total: 50_000 },
  ]);
  assert.deepEqual(mapa.horas, [12, 13, 14, 15, 16]);
  assert.deepEqual(mapa.filas.map((f) => f.nombre), ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']);
  assert.equal(mapa.maximo, 123_456);
  const martes14 = mapa.filas[1].celdas[2];
  assert.equal(martes14.titulo, 'Martes 14:00–15:00');
  assert.equal(martes14.detalle, '5 tickets');
  assert.equal(martes14.paso, 6);
  assert.equal(mapa.mejor, martes14);
  assert.equal(mapa.filas[6].celdas[0].detalle, '1 ticket');
  assert.equal(mapa.filas[0].celdas[0].paso, 0);              // lunes: sin ventas
  assert.equal(mapa.filas[0].celdas[0].detalle, 'Sin ventas');
  assert.equal(mapa.filas.reduce((s, f) => s + f.total, 0), 198_456);
  assert.equal(mapaCalor([]).mejor, null);
});

test('mapa de calor: el HTML y la tabla llevan los importes con centavos', () => {
  const mapa = mapaCalor([{ dia_semana: 2, hora: 14, tickets: 5, total: 123_456 }, { dia_semana: 3, hora: 15, tickets: 1, total: 100 }]);
  const html = mapaCalorHtml(mapa);
  assert.match(html, /data-tip="Martes 14:00–15:00\n\$1,234\.56\n5 tickets"/);
  assert.match(html, /aria-label="Miércoles 15:00–16:00: \$1\.00, 1 ticket"/);
  assert.equal(html.match(/class="celda p\d[^"]*" data-tip/g)!.length, 2);       // solo las celdas con ventas se pintan
  assert.equal(html.match(/ mejor"/g)!.length, 1);                                  // y una sola lleva su importe
  assert.match(html, />\$1,235<\/div>/);
  assert.match(tablaCalor(mapa), /<td class="num">\$1,234\.56<\/td>/);
  assert.match(tablaCalor(mapa), /<th class="num">Total<\/th>/);
});

test('antiguedad: el tramo va por semanas completas y los limites no se mueven', () => {
  assert.deepEqual(TRAMOS_ANTIGUEDAD.map(([clave]) => clave), ['0-2', '3-4', '5-8', '9+']);
  const casos: [number, string][] = [
    [0, '0-2'], [6, '0-2'], [14, '0-2'], [15, '0-2'], [20, '0-2'],   // 20 dias = 2 semanas y 6 dias: aun son 2
    [21, '3-4'], [34, '3-4'], [35, '5-8'], [62, '5-8'], [63, '9+'], [400, '9+'],
    [-3, '0-2'],                                                    // una fecha a futuro no da un tramo inventado
  ];
  for (const [dias, tramo] of casos) assert.equal(tramoDeDias(dias), tramo, `${dias} dias`);
});

test('antiguedad: la escala ordinal va del paso mas claro al mas oscuro, en orden y sin repetir', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => pasoOrdinal(i, 4)), [1, 3, 4, 6]);
  assert.deepEqual([0, 1].map((i) => pasoOrdinal(i, 2)), [1, 6]);
  assert.equal(pasoOrdinal(0, 1), PASOS_CALOR);
  const pasos = [0, 1, 2, 3].map((i) => pasoOrdinal(i, 4));
  assert.deepEqual(pasos, [...new Set(pasos)].sort((a, b) => a - b));
});

test('flechaCambio escribe la flecha y el signo: el color nunca es lo unico', () => {
  assert.equal(flechaCambio(cambio(112_30, 100_00)!), '▲ +12.3%');
  assert.equal(flechaCambio(cambio(50, 100)!), '▼ −50.0%');
  assert.equal(flechaCambio(cambio(100, 100)!), '= 0.0%');
});

test('barras horizontales: la linea chica bajo el valor es texto escapado', () => {
  const html = barrasHorizontales([{ nombre: 'Ropa', valor: 100, texto: '$1.00', tip: 'Ropa', sub: '▲ +5.0% <b>', direccion: 'sube' }, { nombre: 'Hogar', valor: 50, texto: '$0.50', tip: 'Hogar' }]);
  assert.match(html, /<small class="hs sube">▲ \+5\.0% &lt;b&gt;<\/small>/);
  assert.equal(html.match(/<small/g)!.length, 1);   // sin `sub`, nada
});

test('apilada: la columna extra (piezas) entra en todas las filas de la leyenda', () => {
  const html = apilada([
    { nombre: '0–2 semanas', valor: 7_500, color: 'var(--calor-1)', texto: '$75.00', extra: '3 piezas' },
    { nombre: '9 o más semanas', valor: 2_500, color: 'var(--calor-6)', texto: '$25.00', extra: '1 pieza' },
  ]);
  assert.match(html, /<td class="num sec">3 piezas<\/td><td class="num">\$75\.00<\/td><td class="num sec">75\.0%<\/td>/);
  assert.equal(html.match(/<tr>/g)!.length, 2);
  assert.equal(apilada([{ nombre: 'a', valor: 1, color: 'x', texto: '$0.01' }]).includes('piezas'), false);
});

/* ---------- series sin dinero: columnas apiladas, histograma y linea (#802, vista Capturas) ---------- */
import { FORMATO_CALOR_DINERO, promedioMovil } from '../public/graficas.js';

test('columnas apiladas con `unidad` y `linea`: total en el globo, una columna enfocable por dia y la linea de referencia con su hueco', () => {
  const d = { unidad: 'capturas', categorias: [{ etiqueta: '1', titulo: 'Lunes 1' }, { etiqueta: '2', titulo: 'Martes 2' }, { etiqueta: '3', titulo: 'Miércoles 3' }],
    series: [{ nombre: 'Ana', color: 'var(--serie-1)', valores: [4, 0, 2] }, { nombre: 'Beto', color: 'var(--serie-2)', valores: [1, 0, 3] }],
    linea: { nombre: 'Promedio', valores: [null, 2, 3] } };
  const svg = columnas({ ...d, ancho: 600, modo: 'apiladas', entero: true });
  assert.equal((svg.match(/class="hit"/g) ?? []).length, 3);
  assert.equal((svg.match(/var\(--serie-1\)/g) ?? []).length, 2);   // ana pinta 2 de 3 dias: la de cero no deja barra
  assert.ok(svg.includes('Lunes 1'));
  assert.ok(svg.includes('5 capturas') && svg.includes('Ana: 4') && svg.includes('Beto: 1') && svg.includes('Promedio: 3'));
  assert.ok(svg.includes('Sin capturas'));   // el dia en cero se dice, no queda mudo
  assert.equal((svg.match(/<path /g) ?? []).length, 1);   // un solo trazo de referencia, sin el null del principio
  assert.ok(!svg.includes('NaN') && !svg.includes('undefined'));
  // Sin datos y con un solo punto no revienta.
  assert.match(columnas({ categorias: [{ etiqueta: 'a', titulo: 'a' }], series: [{ nombre: 'x', color: 'red', valores: [0] }], ancho: 300, modo: 'apiladas', entero: true }), /<svg/);
});

test('lineaSerie corta el trazo donde no hay dato en lugar de bajarlo a cero', () => {
  const categorias = ['a', 'b', 'c', 'd'].map((etiqueta) => ({ etiqueta }));
  const svg = lineaSerie({ categorias, valores: [60, null, 90, 80], nombre: 'Mediana', ancho: 600, area: false, entero: true });
  assert.equal((svg.match(/class="trazo"/g) ?? []).length, 1);   // a queda solo (sin trazo) y c-d forman el unico tramo
  assert.equal((svg.match(/<circle/g) ?? []).length, 3);
  assert.ok(svg.includes('Sin datos'));
  assert.ok(!svg.includes('NaN'));
  assert.doesNotMatch(svg, /class="area"/);   // sin `area`, solo la linea
  assert.equal((lineaSerie({ categorias, valores: [60, null, 90, 80], nombre: 'M', ancho: 600 }).match(/class="area"/g) ?? []).length, 1);   // un area por tramo largo
});

test('promedioMovil: nada hasta tener `n` valores; enteros por omision y un decimal si se pide', () => {
  assert.deepEqual(promedioMovil([7, 7, 7, 7, 7, 7, 14, 21], 7), [null, null, null, null, null, null, 8, 10]);
  assert.deepEqual(promedioMovil([1, 2, 3], 7), [null, null, null]);
  assert.deepEqual(promedioMovil([1, 1, 2], 3, 1), [null, null, 1.3]);
});

test('el mapa de calor admite conteos sin cambiar el de dinero', () => {
  const datos = [{ dia_semana: 2, hora: 10, tickets: 8, total: 8 }, { dia_semana: 3, hora: 11, tickets: 2, total: 2 }];
  const mapa = mapaCalor(datos, (n) => `${n} capturas`);
  assert.equal(mapa.mejor.detalle, '8 capturas');
  const html = mapaCalorHtml(mapa, { ...FORMATO_CALOR_DINERO, valor: (n) => `${n} capturas`, eje: String, vacio: 'Sin capturas', titulo: 'Capturas por hora', escala: 'Más oscuro, más capturas' });
  assert.ok(html.includes('8 capturas') && html.includes('Sin capturas') && html.includes('Capturas por hora'));
  assert.ok(!html.includes('$'));
  assert.ok(tablaCalor(mapa, String).includes('>8<'));
  // Sin pasar formato sigue siendo dinero.
  assert.ok(mapaCalorHtml(mapaCalor([{ dia_semana: 1, hora: 9, tickets: 1, total: 12345 }])).includes('$123'));
});

test('la leyenda del mapa de conteos chicos usa un escalon por valor; con conteos grandes queda como siempre', () => {
  const formato = { ...FORMATO_CALOR_DINERO, entero: true, valor: (n: number) => `${n}`, eje: String, vacio: 'Sin datos', titulo: 'Conteos', escala: 'Mas oscuro, mas' };
  const leyenda = (maximo: number) => {
    const html = mapaCalorHtml(mapaCalor([{ dia_semana: 1, hora: 9, tickets: maximo, total: maximo }, { dia_semana: 2, hora: 9, tickets: 1, total: 1 }]), formato);
    return [...html.matchAll(/<span class="calor-paso"><i class="celda p(\d)"><\/i>([^<]+)<\/span>/g)].map((m) => [Number(m[1]), m[2]]);
  };
  assert.deepEqual(leyenda(3), [[2, '1'], [4, '2'], [6, '3']]);          // 1, 2, 3: sin «hasta 0», «0–1» ni «1–1»
  assert.deepEqual(leyenda(1), [[6, '1']]);
  assert.deepEqual(leyenda(5).map((p) => p[1]), ['1', '2', '3', '4', '5']);
  const textos = leyenda(40).map((p) => p[1]);
  assert.equal(new Set(textos).size, 6);                                // seis pasos, todos distintos
  assert.equal(textos[0], 'hasta 7');
  // Los conteos grandes y el dinero siguen igual que antes.
  const dinero = mapaCalorHtml(mapaCalor([{ dia_semana: 1, hora: 9, tickets: 1, total: 120_000 }]));
  assert.ok(dinero.includes('hasta $200') && dinero.includes('$1,000–$1,200'));
});

test('escalaNumero: marcas 1, 2, 5 y con `entero` nunca fracciones', () => {
  const e = escalaNumero(123_456);
  assert.ok(e.tope >= 123_456);
  const pasos = e.marcas.slice(1).map((m: number, i: number) => m - e.marcas[i]);
  assert.ok(pasos.every((p: number) => p === pasos[0]));
  assert.ok(escalaNumero(3, { entero: true }).marcas.every(Number.isInteger));
  assert.ok(escalaNumero(0).tope > 0, 'sin datos la escala no se divide entre cero');
});

test('columnas y lineaSerie: ceros sin columna pero con globo, nombres escapados y apiladas con total', () => {
  const categorias = [{ etiqueta: '1 nov', titulo: '1 nov 2026' }, { etiqueta: '2 nov', titulo: '2 nov 2026' }];
  const series = [{ nombre: 'Emitidos', color: 'var(--serie-1)', valores: [1000, 0] }, { nombre: 'Canjeados <b>', color: 'var(--serie-2)', valores: [500, 0] }];
  const agrupadas = columnas({ categorias, series, ancho: 400 });
  assert.equal(agrupadas.match(/<rect x=/g)!.length, 2, 'los ceros no pintan columna');
  assert.equal(agrupadas.match(/class="hit"/g)!.length, 2, 'pero cada categoria tiene su globo');
  assert.ok(agrupadas.includes('Canjeados &lt;b&gt;: 500'));
  assert.match(columnas({ categorias, series, ancho: 400, modo: 'apiladas' }), /Total: 1500/);
  assert.ok(!columnas({ categorias, series: [{ nombre: 'x', color: 'red', valores: [0, 0] }], ancho: 400 }).includes('NaN'));
  assert.equal(lineaSerie({ categorias, valores: [100, 300], nombre: 'Saldo', ancho: 400 }).match(/<circle/g)!.length, 2);
  assert.ok(!lineaSerie({ categorias: [categorias[0]], valores: [0], nombre: 'Saldo', ancho: 300 }).includes('NaN'));
  assert.equal(leyendaSeries(series).match(/class="llave"/g)!.length, 2);
});

test('minigrafica: una linea por tramo continuo, los huecos no se dibujan y con menos de dos puntos no hay nada', () => {
  assert.equal(minigrafica([]), '');
  assert.equal(minigrafica([5]), '');
  assert.equal(minigrafica([null, 5, null]), '');
  const svg = minigrafica([1, 2, 3, 4], { clase: 's2', etiqueta: 'Tendencia <b>' });
  assert.match(svg, /class="mini s2"/);
  assert.equal((svg.match(/class="linea"/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /<b>/);                                  // la etiqueta va escapada
  const hueco = minigrafica([1, 2, null, 4, 5]);
  assert.equal((hueco.match(/class="linea"/g) ?? []).length, 2);    // un hueco parte la linea en dos
  assert.match(minigrafica([3, 3, 3]), /class="linea" d="M0\.00,17\.00 L50\.00,17\.00 L100\.00,17\.00"/);   // plana: a media altura
});

test('graficaTiempo: columnas, lineas de comparacion y promedio, y cada cubeta con su globo', () => {
  const datos = Array.from({ length: 7 }, (_, i) => ({
    clave: `2026-11-0${i + 1}`, etiqueta: `${i + 1}`, titulo: `Dia ${i + 1}`, valor: (i + 1) * 10000, detalle: ['1 ticket'],
    media: i >= 2 ? 20000 : null, comparacion: i === 3 ? null : 15000, ritmo: i === 0 ? null : 12000,
  }));
  const svg = graficaTiempo(datos, { ancho: 700, clicable: true });
  assert.equal((svg.match(/<path class="barra/g) ?? []).length, 7);
  assert.equal((svg.match(/data-dia="/g) ?? []).length, 7);
  assert.match(svg, /<path class="comp"/);
  assert.equal((svg.match(/<path class="comp"/g) ?? []).length, 2);   // el null de la cubeta 4 corta la linea en dos
  assert.match(svg, /<path class="media"/);
  assert.match(svg, /<path class="ritmo"/);
  assert.ok(svg.includes(`data-tip="${['Dia 7', '$700.00', '1 ticket'].join(String.fromCharCode(10))}"`));
  const pasiva = graficaTiempo(datos, { ancho: 700 });
  assert.doesNotMatch(pasiva, /data-dia=/);
  assert.match(pasiva, /class="hit pasiva"/);
  assert.equal(graficaTiempo([], { ancho: 700 }), '');
  // Con mas de 45 cubetas es una linea con area y solo el gran total entra al teclado por zona: sin tabindex en 60 zonas.
  const muchos = Array.from({ length: 60 }, (_, i) => ({ clave: `d${i}`, etiqueta: `${i}`, titulo: `D${i}`, valor: 100 * i, detalle: [] }));
  const linea = graficaTiempo(muchos, { ancho: 700 });
  assert.match(linea, /<path class="trazo"/);
  assert.doesNotMatch(linea, /tabindex/);
  // Un titulo malicioso no entra como HTML.
  assert.doesNotMatch(graficaTiempo([{ ...datos[0], titulo: '"><script>x</script>' }], { ancho: 700 }), /<script>/);
});

test('B5: una fecha con hora y un dia, cada uno con un solo formato', () => {
  const instante = '2026-11-15T12:00:00Z';   // el 15 en cualquier zona de las Americas y Europa
  assert.match(fechaHora(instante), /^15 nov 2026, \d{1,2}:\d{2} [ap]\.m\.$/);
  assert.equal(FECHAS_TICKET.fecha(instante), '15 nov');
  assert.match(FECHAS_TICKET.hora(instante), /^\d{1,2}:\d{2} [ap]\.m\.$/);
  assert.doesNotMatch(fechaHora(instante), /dom|domingo|\//, 'ni dia de la semana ni 15/11/26');
});
