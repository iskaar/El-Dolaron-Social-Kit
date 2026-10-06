// node --test src/graficas.test.ts
// Dinero al centavo, escalas y cuadre de /reportes (Issue #166): lo que no toca el DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pesos, dolarones, pesosEje, pesosConSigno, escala, cambio, rellenarDias, textoPeriodo, verificarCuadre,
  PASOS_CALOR, pasoCalor, pasosDeLaEscala, horasConVentas, textoHora, rangoHora, mapaCalor, mapaCalorHtml, tablaCalor,
  TRAMOS_ANTIGUEDAD, tramoDeDias, pasoOrdinal, flechaCambio, barrasHorizontales, apilada,
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

test('escala da marcas redondas que cubren el maximo', () => {
  assert.deepEqual(escala(0).marcas, [0, 25, 50, 75, 100]);   // sin ventas: de $0 a $1
  const e = escala(123_456);                 // $1,234.56
  assert.ok(e.tope >= 123_456);
  assert.equal(e.marcas[0], 0);
  const pasos = e.marcas.slice(1).map((m, i) => m - e.marcas[i]);
  assert.ok(pasos.every((p) => p === pasos[0]), 'pasos iguales');
  assert.ok([1, 2, 2.5, 5].includes(pasos[0] / 100 / 10 ** Math.floor(Math.log10(pasos[0] / 100))), 'paso redondo');
  assert.equal(escala(100_000).tope, 100_000);   // $1,000 exacto: no se pasa de largo
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
