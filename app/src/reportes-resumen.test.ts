// node --test src/reportes-resumen.test.ts
// Resumen de /reportes (Issue #802): fechas, comparacion, cubetas, meta, hallazgos y el endpoint contra el doble de D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { sumarDias } from '../public/graficas.js';
import {
  mesAtras, ventanaComparacion, cubetas, granosPermitidos, granoEfectivo, armarCubetas, promedioMovil, calcularMeta, ritmoPorCubeta,
  cambioKpi, hallazgos, hallazgosHtml, tarjetasKpi, tarjetasHtml, textoComparacion, UMBRALES, edadPromedio, datosTendencia, metaHtml, canalesHtml,
  categoriasHtml, leyendaTendencia, tablaTendencia, unidadGrano, rangoTexto,
} from '../public/reportes-resumen.js';

/* ---------- puras ---------- */

test('A3: el texto de la comparacion lleva el año cuando cruza de año o es de otro año, y no cuando es del mismo', () => {
  const d = (periodo: { desde: string; hasta: string; dias: number }, comparacion: { desde: string; hasta: string; dias: number }) => ({ comparar: 'anterior', periodo, comparacion });
  // 366 dias terminando el 15 nov 2026: lo de antes cae en 2024-2025
  assert.equal(textoComparacion(d({ desde: '2025-11-15', hasta: '2026-11-15', dias: 366 }, { desde: '2024-11-14', hasta: '2025-11-14', dias: 366 })),
    'Comparado con 14 nov 2024 – 14 nov 2025');
  // un solo dia de otro año
  assert.equal(textoComparacion(d({ desde: '2026-01-01', hasta: '2026-01-01', dias: 1 }, { desde: '2025-12-31', hasta: '2025-12-31', dias: 1 })), 'Comparado con 31 dic 2025');
  // mismo año: sin año, como siempre
  assert.equal(textoComparacion(d({ desde: '2026-10-19', hasta: '2026-11-15', dias: 28 }, { desde: '2026-09-21', hasta: '2026-10-18', dias: 28 })), 'Comparado con 21 sep – 18 oct');
  assert.equal(rangoTexto('2026-10-01', '2026-10-01', '2026'), '1 oct');
  assert.equal(rangoTexto('2025-12-29', '2026-01-04', '2026'), '29 dic 2025 – 4 ene 2026');
});

test('mesAtras: el mismo dia del mes pasado; si no existe, el ultimo', () => {
  assert.deepEqual(mesAtras('2026-11-15'), { dia: '2026-10-15', recortado: false });
  assert.deepEqual(mesAtras('2026-03-31'), { dia: '2026-02-28', recortado: true });
  assert.deepEqual(mesAtras('2026-03-29'), { dia: '2026-02-28', recortado: true });
  assert.deepEqual(mesAtras('2024-03-29'), { dia: '2024-02-29', recortado: false });   // bisiesto
  assert.deepEqual(mesAtras('2026-01-05'), { dia: '2025-12-05', recortado: false });
  assert.deepEqual(mesAtras('2026-10-31'), { dia: '2026-09-30', recortado: true });
});

test('ventanaComparacion: periodo anterior, mes pasado y sus bordes', () => {
  assert.deepEqual(ventanaComparacion('2026-11-09', '2026-11-15', 'anterior'), { desde: '2026-11-02', hasta: '2026-11-08', dias: 7 });
  assert.deepEqual(ventanaComparacion('2026-11-15', '2026-11-15', 'anterior'), { desde: '2026-11-14', hasta: '2026-11-14', dias: 1 });
  assert.equal(ventanaComparacion('2026-11-01', '2026-11-15', 'ninguna'), null);
  // Mismo rango un mes atras.
  assert.deepEqual(ventanaComparacion('2026-11-01', '2026-11-15', 'mes'), { desde: '2026-10-01', hasta: '2026-10-15', dias: 15 });
  assert.deepEqual(ventanaComparacion('2026-11-01', '2026-11-30', 'mes'), { desde: '2026-10-01', hasta: '2026-10-30', dias: 30 });
  // El mes entero contra el mes pasado entero: 31 dias contra 30, sin invadir el mes en curso.
  assert.deepEqual(ventanaComparacion('2026-10-01', '2026-10-31', 'mes'), { desde: '2026-09-01', hasta: '2026-09-30', dias: 30 });
  // 29 a 31 en un mes cuyo anterior es mas corto: se conserva el largo y se queda dentro de febrero (no un solo dia).
  assert.deepEqual(ventanaComparacion('2026-03-29', '2026-03-31', 'mes'), { desde: '2026-02-26', hasta: '2026-02-28', dias: 3 });
  assert.deepEqual(ventanaComparacion('2026-03-31', '2026-04-05', 'mes'), { desde: '2026-02-28', hasta: '2026-03-05', dias: 6 });
  // Un rango que cruza febrero no se alarga: el largo del periodo es el tope.
  assert.deepEqual(ventanaComparacion('2026-02-28', '2026-03-03', 'mes'), { desde: '2026-01-28', hasta: '2026-01-31', dias: 4 });
  // Cruce de anio.
  assert.deepEqual(ventanaComparacion('2026-01-30', '2026-02-02', 'mes'), { desde: '2025-12-30', hasta: '2026-01-02', dias: 4 });
  for (const [d, h] of [['2026-03-29', '2026-03-31'], ['2026-10-01', '2026-10-31'], ['2026-03-31', '2026-04-05'], ['2026-02-28', '2026-03-03']]) {
    const v = ventanaComparacion(d, h, 'mes');
    assert.ok(v.hasta < d, 'la ventana no invade el periodo');
    assert.ok(v.dias <= (Date.parse(h) - Date.parse(d)) / 86_400_000 + 1, 'no es mas larga que el periodo');
  }
});

test('cubetas: dia, semana de lunes a domingo y mes calendario, con lo parcial marcado', () => {
  assert.equal(cubetas('2026-11-09', '2026-11-15', 'dia').length, 7);
  const semanas = cubetas('2026-11-04', '2026-11-18', 'semana');   // miercoles 4 a miercoles 18
  assert.deepEqual(semanas.map((c) => [c.desde, c.hasta, c.dias, c.parcial]), [
    ['2026-11-04', '2026-11-08', 5, true], ['2026-11-09', '2026-11-15', 7, false], ['2026-11-16', '2026-11-18', 3, true],
  ]);
  const meses = cubetas('2026-01-30', '2026-03-02', 'mes');
  assert.deepEqual(meses.map((c) => [c.desde, c.hasta, c.dias, c.parcial]), [
    ['2026-01-30', '2026-01-31', 2, true], ['2026-02-01', '2026-02-28', 28, false], ['2026-03-01', '2026-03-02', 2, true],
  ]);
  assert.equal(cubetas('2026-11-01', '2026-11-30', 'mes')[0].parcial, false);
  // Los dias de todas las cubetas suman los del periodo, sin huecos ni repetidos.
  for (const g of ['dia', 'semana', 'mes']) assert.equal(cubetas('2026-01-17', '2026-06-03', g).reduce((s, c) => s + c.dias, 0), 138);
});

test('el grano: se ofrece solo si da dos cubetas o mas, y el automatico cambia a los 35 dias', () => {
  assert.deepEqual(granosPermitidos('2026-11-15', '2026-11-15'), { dia: true, semana: false, mes: false });
  assert.deepEqual(granosPermitidos('2026-11-01', '2026-11-30'), { dia: true, semana: true, mes: false });
  assert.deepEqual(granosPermitidos('2026-10-19', '2026-11-15'), { dia: true, semana: true, mes: true });
  assert.equal(granoEfectivo('', '2026-10-19', '2026-11-15'), 'dia');
  assert.equal(granoEfectivo('semana', '2026-10-19', '2026-11-15'), 'semana');
  assert.equal(granoEfectivo('mes', '2026-11-01', '2026-11-30'), 'dia');      // no se permite: vuelve al automatico
  assert.equal(granoEfectivo('', '2026-06-01', '2026-11-15'), 'semana');      // mas de 35 dias
  assert.equal(granoEfectivo('basura', '2026-11-15', '2026-11-15'), 'dia');
});

test('armarCubetas: las cubetas suman los totales y la comparacion va dia a dia', () => {
  const porDia = new Map();
  const poner = (d: string, ventas: number, tickets: number) => porDia.set(d, { ventas, tickets, piezas: tickets * 2, descuento: tickets, gastos: 0 });
  poner('2026-11-02', 1000, 1); poner('2026-11-04', 500, 2); poner('2026-11-09', 700, 3); poner('2026-11-11', 300, 1);   // periodo: 9 a 15
  poner('2026-11-10', 9999, 9);
  const ventana = ventanaComparacion('2026-11-09', '2026-11-15', 'anterior');   // 2 a 8
  const r = armarCubetas({ desde: '2026-11-09', hasta: '2026-11-15', grano: 'dia', ventana, porDia });
  assert.equal(r.cubetas.length, 7);
  assert.equal(r.totales.ventas, 700 + 300 + 9999);
  assert.equal(r.anterior!.ventas, 1500);
  assert.equal(r.cubetas.reduce((s: number, c: { ventas: number }) => s + c.ventas, 0), r.totales.ventas);
  assert.equal(r.cubetas.reduce((s: number, c: { anterior: { ventas: number } }) => s + c.anterior.ventas, 0), r.anterior!.ventas);
  assert.equal(r.cubetas[0].anterior.ventas, 1000);                              // 9 nov contra 2 nov
  assert.equal(r.cubetas[2].anterior.ventas, 500);                               // 11 nov contra 4 nov
  const semanas = armarCubetas({ desde: '2026-11-04', hasta: '2026-11-18', grano: 'semana', ventana: ventanaComparacion('2026-11-04', '2026-11-18', 'mes'), porDia });
  assert.equal(semanas.cubetas.length, 3);
  assert.equal(semanas.cubetas.reduce((s: number, c: { dias: number }) => s + c.dias, 0), 15);
  // Una ventana mas corta que el periodo deja la cola sin comparacion: null, no ceros.
  const corta = armarCubetas({ desde: '2026-03-29', hasta: '2026-03-31', grano: 'dia', ventana: { desde: '2026-02-28', hasta: '2026-02-28', dias: 1 }, porDia: new Map() });
  assert.deepEqual(corta.cubetas.map((c: { anterior: unknown }) => c.anterior === null), [false, true, true]);
  const sin = armarCubetas({ desde: '2026-11-09', hasta: '2026-11-10', grano: 'dia', ventana: null, porDia, sinGastos: true });
  assert.equal(sin.anterior, null);
  assert.equal(sin.totales.gastos, null);
  assert.equal(sin.cubetas[0].gastos, null);
});

test('promedioMovil de 7 dias: nada hasta tener 7', () => {
  assert.deepEqual(promedioMovil([7, 7, 7, 7, 7, 7, 14, 21], 7), [null, null, null, null, null, null, 8, 10]);
  assert.deepEqual(promedioMovil([1, 2, 3], 7), [null, null, null]);
});

test('meta: acumulado, proyeccion lineal, mes cerrado y sin meta', () => {
  const acumulado = Array.from({ length: 15 }, (_, i) => (i + 1) * 10_000);          // $100 por dia durante 15 dias
  const m = calcularMeta({ monto: 400_000, acumuladoPorDia: acumulado, diasMes: 30 });
  assert.equal(m.acumulado, 150_000);
  assert.equal(m.proyeccion, 300_000);                                                 // 150,000 / 15 x 30
  assert.equal(m.avance_pct, 37.5);
  assert.equal(m.proyeccion_pct, 75);
  assert.equal(m.brecha, -100_000);
  assert.equal(m.brecha_pct, -25);
  assert.equal(m.cerrado, false);
  assert.equal(m.confiable, true);
  const poca = calcularMeta({ monto: 400_000, acumuladoPorDia: [10_000, 30_000], diasMes: 30 });
  assert.equal(poca.proyeccion, 450_000);
  assert.equal(poca.confiable, false);
  const cerrado = calcularMeta({ monto: 400_000, acumuladoPorDia: Array.from({ length: 30 }, (_, i) => (i + 1) * 15_000), diasMes: 30 });
  assert.equal(cerrado.cerrado, true);
  assert.equal(cerrado.proyeccion, cerrado.acumulado);
  const sin = calcularMeta({ monto: null, acumuladoPorDia: acumulado, diasMes: 30 });
  assert.equal(sin.monto, null);
  assert.equal(sin.proyeccion_pct, null);
  assert.equal(sin.acumulado, 150_000);
  assert.equal(calcularMeta({ monto: 100, acumuladoPorDia: [], diasMes: 30 }).proyeccion, 0);
  // El ritmo de cada cubeta: dias de la cubeta dentro del mes de la meta.
  const ritmo = ritmoPorCubeta(cubetas('2026-10-30', '2026-11-02', 'dia'), { monto: 300_000, dias_mes: 30 }, '2026-11');
  assert.deepEqual(ritmo, [null, null, 10_000, 10_000]);
  assert.deepEqual(ritmoPorCubeta(cubetas('2026-11-01', '2026-11-07', 'semana'), { monto: 300_000, dias_mes: 30 }, '2026-11'), [10_000, 60_000]);   // domingo 1 y lunes 2 a sabado 7
  assert.deepEqual(ritmoPorCubeta(cubetas('2026-11-01', '2026-11-02', 'dia'), null, '2026-11'), [null, null]);
});

test('cambioKpi: el color sale de lo que significa, no de la direccion', () => {
  assert.deepEqual(cambioKpi(112_300, 100_000), { flecha: '▲', texto: '+12.3%', tono: 'bien', direccion: 'sube' });
  assert.equal(cambioKpi(90_000, 100_000)!.tono, 'mal');
  assert.equal(cambioKpi(120_000, 100_000, { bueno: 'baja' })!.tono, 'mal');       // gastos que suben
  assert.equal(cambioKpi(80_000, 100_000, { bueno: 'baja' })!.tono, 'bien');       // gastos que bajan
  assert.equal(cambioKpi(80_000, 100_000, { bueno: 'neutro' })!.tono, 'neu');
  assert.equal(cambioKpi(100_000, 100_000)!.tono, 'neu');
  assert.equal(cambioKpi(5, 0), null);
  assert.equal(cambioKpi(5, null), null);
  assert.deepEqual(cambioKpi(5.8, 4, { tipo: 'pp', bueno: 'baja' }), { flecha: '▲', texto: '+1.8 pp', tono: 'mal', direccion: 'sube' });
  assert.equal(cambioKpi(3.1, 4, { tipo: 'pp', bueno: 'baja' })!.texto, '−0.9 pp');
  // El resultado puede ser negativo: contra una base no positiva se dice la diferencia en pesos.
  assert.equal(cambioKpi(5_000, -2_000, { tipo: 'abs' })!.texto, '+$70.00');
  assert.equal(cambioKpi(-5_000, 2_000, { tipo: 'abs' })!.texto, '−350.0%');
});

const base = () => ({
  periodo: { desde: '2026-10-19', hasta: '2026-11-15', dias: 28 }, comparar: 'anterior', comparacion: { desde: '2026-09-21', hasta: '2026-10-18', dias: 28 },
  totales: { ventas: 2_000_000, tickets: 100, piezas: 250, descuento: 40_000, gastos: 800_000 },
  anterior: { ventas: 1_800_000, tickets: 90, piezas: 220, descuento: 38_000, gastos: 790_000 },
  categorias: [
    { categoria: 'ropa', total: 900_000, piezas: 100, anterior: 700_000 },
    { categoria: 'hogar', total: 600_000, piezas: 80, anterior: 590_000 },
    { categoria: 'juguetes', total: 300_000, piezas: 40, anterior: 310_000 },
  ],
  mejor_dia: { dia: '2026-11-14', ventas: 90_000, tickets: 5 }, dias_con_ventas: 25,
  inventario: { valor: 10_000_000, unidades: 4000, por_antiguedad: [{ tramo: '9+', piezas: 100, unidades: 120, valor: 1_000_000 }] },
});
const textoPlano = (h: { partes: [string, boolean?][] }) => h.partes.map(([t]) => t).join('');

test('hallazgos: cada regla respeta su umbral y calla si es debil', () => {
  // Con datos tranquilos: solo crece una categoria (+$2,000, +28.6 %) y el piso viejo pesa 10 %: no pasa el 15 %.
  const tranquilo = hallazgos(base(), { nombreCategoria: (c: string) => c.toUpperCase() });
  assert.deepEqual(tranquilo.map((h: { clave: string }) => h.clave), ['categoria_crece']);
  assert.match(textoPlano(tranquilo[0]), /^ROPA es la categoría que más creció: \+\$2,000\.00 \(\+28\.6 %\)/);
  assert.equal(tranquilo[0].tono, 'bien');

  const d = base();
  d.totales.descuento = 140_000;                       // 6.5 % del bruto contra 2.1 %: +4.5 pp y $1,400
  d.categorias[2].total = 100_000;                     // juguetes cae $2,100 (-67 %)
  d.totales.gastos = 1_000_000;                        // +26.6 %, +$2,100
  d.inventario.por_antiguedad[0].valor = 2_000_000;    // 20 % del valor en piso
  const todos = hallazgos(d);
  assert.deepEqual(todos.map((h: { clave: string }) => h.clave), ['descuento_sube', 'gastos_suben', 'categoria_cae', 'categoria_crece']);   // maximo 4, problemas primero
  assert.equal(todos[0].tono, 'mal');
  assert.match(textoPlano(todos[0]), /\+4\.5 pp/);

  // Debajo del umbral no hay nada: ni el monto ni el porcentaje ni los dias bastan.
  const debil = base();
  debil.categorias[0].total = 700_000 + UMBRALES.categoriaMonto - 1;     // casi $1,000
  assert.deepEqual(hallazgos(debil), []);
  const pct = base();
  pct.categorias = [{ categoria: 'ropa', total: 5_000_000, piezas: 1, anterior: 4_600_000 }];    // +$4,000 pero +8.7 %
  pct.totales.ventas = 5_000_000;
  assert.deepEqual(hallazgos(pct), []);
  const corto = base();
  corto.categorias = [];
  corto.periodo = { desde: '2026-11-13', hasta: '2026-11-15', dias: 3 };
  corto.comparacion = { desde: '2026-11-10', hasta: '2026-11-12', dias: 3 };
  assert.deepEqual(hallazgos(corto), []);                                 // mejor dia: pocos dias del periodo
  const sinComp = base();
  sinComp.comparacion = null; sinComp.anterior = null; sinComp.comparar = 'ninguna';
  assert.deepEqual(hallazgos(sinComp), []);

  // Mejor dia: pasa con 1.5 veces el promedio y cae por debajo.
  const mejor = base();
  mejor.categorias = [];
  mejor.mejor_dia = { dia: '2026-11-14', ventas: 120_000, tickets: 6 };
  assert.equal(hallazgos(mejor)[0].clave, 'mejor_dia');
  assert.match(textoPlano(hallazgos(mejor)[0]), /^El mejor día fue el sábado,? 14 de noviembre, con \$1,200\.00 en 6 tickets/);
  mejor.mejor_dia.ventas = 100_000;                                       // 1.4 veces el promedio de $714.29
  assert.deepEqual(hallazgos(mejor), []);

  // Comparado de otro largo (mes de 31 dias contra uno de 30): se escala al largo del periodo.
  const escalado = base();
  escalado.categorias = [{ categoria: 'ropa', total: 1_000_000, piezas: 1, anterior: 900_000 }];
  escalado.comparacion = { desde: '2026-09-01', hasta: '2026-09-30', dias: 30 };
  escalado.periodo = { desde: '2026-10-01', hasta: '2026-10-31', dias: 31 };
  assert.deepEqual(hallazgos(escalado), []);                              // 900,000 x 31/30 = 930,000: +7.5 %, no llega a 15 %
});

test('el bloque «Que cambio» dice «sin cambios relevantes» con menos de dos hallazgos', () => {
  assert.match(hallazgosHtml([]), /Sin cambios relevantes/);
  const uno = hallazgos(base());
  assert.equal(uno.length, 1);
  assert.match(hallazgosHtml(uno), /Sin cambios relevantes/);
  const d = base();
  d.categorias[2].total = 100_000;
  const dos = hallazgos(d);
  assert.ok(dos.length >= 2);
  assert.match(hallazgosHtml(dos), /<ul class="hallazgos">/);
  assert.doesNotMatch(hallazgosHtml(dos), /Sin cambios/);
});

test('las tarjetas: 8, con el color por significado y el valor en piso sin cambio ni minigrafica', () => {
  const d: any = {
    ...base(), grano: 'dia', meta_mes: '2026-11',
    meta: calcularMeta({ monto: 4_000_000, acumuladoPorDia: Array.from({ length: 15 }, (_, i) => (i + 1) * 100_000), diasMes: 30 }),
    cubetas: Array.from({ length: 5 }, (_, i) => ({ desde: `2026-11-0${i + 1}`, hasta: `2026-11-0${i + 1}`, dias: 1, parcial: false, ventas: 100 + i, tickets: 2, piezas: 4, descuento: 5, gastos: 50, anterior: null })),
  };
  const inv = { valor: 10_000_000, unidades: 4000, por_categoria: [{ piezas: 10, dias_promedio: 20 }, { piezas: 30, dias_promedio: 40 }, { piezas: 5, dias_promedio: null }] };
  d.totales.descuento = 100_000;                                           // 4.8 % del bruto contra 2.1 %: sube, y es malo
  const k = tarjetasKpi(d, inv);
  assert.deepEqual(k.map((x: { clave: string }) => x.clave), ['ventas', 'tickets', 'ticket', 'piezas', 'descuento', 'gastos', 'resultado', 'piso']);
  const por = Object.fromEntries(k.map((x: { clave: string }) => [x.clave, x]));
  assert.equal(por.ventas.valor, '$20,000.00');
  assert.equal(por.ventas.cambio.tono, 'bien');
  assert.equal(por.ventas.avance.pct, 37.5);
  assert.equal(por.gastos.cambio.tono, 'mal');                           // los gastos subieron: malo aunque sea una flecha arriba
  assert.equal(por.descuento.cambio.flecha, '▲');
  assert.equal(por.descuento.cambio.tono, 'mal');
  assert.equal(por.resultado.valor, '$12,000.00');
  assert.equal(por.piso.valor, '$100,000.00');
  assert.equal(por.piso.cambio, null);
  assert.deepEqual(por.piso.serie, []);
  assert.equal(edadPromedio(inv), 35);                                    // (10 x 20 + 30 x 40) / 40
  const html = tarjetasHtml(k);
  assert.equal((html.match(/class="tarjeta kpi"/g) ?? []).length, 8);
  assert.match(html, /▲ \+11\.1%/);
  assert.match(html, /Sin historial de inventario/);
  assert.match(html, /Meta de noviembre: 37\.5 %/);
  // Sin comparar o sin base: lo dice.
  d.comparacion = null; d.anterior = null; d.comparar = 'ninguna';
  assert.match(tarjetasHtml(tarjetasKpi(d, null)), /Sin comparar/);
  assert.match(tarjetasHtml(tarjetasKpi(d, null)), /Cargando el inventario/);
  assert.equal(textoComparacion(d), 'Sin comparar');
  // Con tienda: gastos y resultado no se calculan.
  d.totales.gastos = null;
  const t = tarjetasKpi(d, null);
  assert.equal(t[5].valor, '—');
  assert.equal(t[6].valor, '—');
});

test('los textos escapan lo que llega de la base y la meta dice donde se fija', () => {
  const d: any = { ...base(), grano: 'dia', meta_mes: '2026-11', canales: {
    tienda: { ventas: 1000, tickets: 1, anterior: 500 }, whatsapp: { ventas: 0, tickets: 0, anterior: 0 }, revendedoras: { ventas: 0, tickets: 0, anterior: 0 },
    mercado_libre: { total: 36_000, piezas: 2, piezas_reales: 0, estimado: true, anterior: null },
  } };
  d.categorias = [{ categoria: '<img src=x onerror=1>', total: 100, piezas: 1, anterior: 50 }];
  d.meta = calcularMeta({ monto: null, acumuladoPorDia: [100, 200], diasMes: 30 });
  assert.match(metaHtml(d), /Meta de ventas del mes/);
  assert.match(metaHtml(d), /No hay una meta/);
  d.meta = { solo_negocio: true };
  assert.match(metaHtml(d), /todo el negocio/);
  assert.doesNotMatch(categoriasHtml(d), /<img/);
  assert.match(canalesHtml(d), /estimado/);
  assert.match(canalesHtml(d), /No suma a las ventas netas/);
  d.meta = calcularMeta({ monto: 4_000_000, acumuladoPorDia: [100, 200], diasMes: 30 });
  d.cubetas = [{ desde: '2026-11-01', hasta: '2026-11-01', dias: 1, parcial: false, ventas: 1, tickets: 1, piezas: 1, descuento: 0, gastos: 0, anterior: null },
    { desde: '2026-11-02', hasta: '2026-11-02', dias: 1, parcial: false, ventas: 2, tickets: 1, piezas: 1, descuento: 0, gastos: 0, anterior: null }];
  assert.equal(datosTendencia(d)[0].ritmo, Math.round(4_000_000 / 30));
});

/* ---------- el endpoint ---------- */

type T = ReturnType<typeof tienda>;
const vender = async (t: T, dia: string, extra: Record<string, unknown> = {}, piezas = 1) => {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201);
  const cuando = `${dia}T18:00:00.000Z`;        // mediodia de la tienda
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  return id;
};
const resumen = async (t: T, consulta: string) => {
  const r = await t.pedir(`/api/reportes/resumen?${consulta}`, undefined, 'GET');
  return r;
};
const suma = (filas: { ventas: number }[]) => filas.reduce((s, f) => s + f.ventas, 0);

test('el resumen cuadra al centavo con /api/reportes: ventas, tickets, piezas, dias, descuentos y comparacion', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  const hoy = hoyTienda();
  const dia = (n: number) => sumarDias(hoy, -n);
  const v1 = await vender(t, dia(1));                       // $250
  await vender(t, dia(1), {}, 2);                           // $500
  await vender(t, dia(2));                                  // $250
  const cancelada = await vender(t, dia(3));
  assert.equal((await t.pedir(`/api/ventas/${cancelada}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const doble = await vender(t, dia(3), {}, 2);             // $500, devuelve 1 pieza -> $250
  const linea = (await t.pedir(`/api/ventas/${doble}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${doble}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  await vender(t, dia(10));                                 // periodo anterior (dias 8 a 14 atras)
  await vender(t, dia(11), {}, 3);                          // $750
  t.db.prepare('update ventas set descuento = 3000, promo = 1000 where id = ?').run(v1);
  // Un canal de WhatsApp (pedido sin revendedora).
  const wa = await vender(t, dia(2));
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
    values ('p1', 1, 'x', '1', 'tienda', 0, 'nadie@prueba.mx', 'vendido', '', 0, 'efectivo', 0, '', ?, '', '')`).run(wa);
  t.db.prepare("update ventas set pedido_id = 'p1' where id = ?").run(wa);

  const viejo = (await t.pedir('/api/reportes?dias=7', undefined, 'GET')).cuerpo;
  const r = await resumen(t, 'dias=7');
  assert.equal(r.status, 200);
  const d = r.cuerpo;

  assert.equal(d.totales.ventas, viejo.resumen.total);
  assert.equal(d.totales.tickets, viejo.resumen.ventas);
  assert.equal(d.totales.piezas, viejo.resumen.piezas);
  assert.equal(d.anterior.ventas, viejo.anterior.total);
  assert.equal(d.anterior.tickets, viejo.anterior.ventas);
  assert.equal(d.anterior.piezas, viejo.anterior.piezas);
  assert.equal(d.totales.ventas, 25000 + 50000 + 25000 + 25000 + 25000);   // 1 + 2 + 1 + (2 menos 1 devuelta) + whatsapp
  // Los totales son la suma de la serie, y la serie es la de /api/reportes dia por dia.
  assert.equal(suma(d.cubetas), d.totales.ventas);
  assert.equal(d.cubetas.reduce((s: number, c: { tickets: number }) => s + c.tickets, 0), d.totales.tickets);
  assert.equal(d.cubetas.reduce((s: number, c: { piezas: number }) => s + c.piezas, 0), d.totales.piezas);
  assert.equal(suma(d.cubetas.map((c: { anterior: { ventas: number } | null }) => c.anterior ?? { ventas: 0 })), d.anterior.ventas);
  for (const f of viejo.por_dia) assert.equal(d.cubetas.find((c: { desde: string }) => c.desde === f.dia).ventas, f.total, f.dia);
  assert.equal(d.cubetas.length, 7);
  assert.equal(d.grano, 'dia');
  assert.equal(d.comparar, 'anterior');
  assert.deepEqual(d.comparacion, { desde: sumarDias(dia(6), -7), hasta: sumarDias(dia(6), -1), dias: 7 });
  // Descuentos: lo mismo que el bloque de descuentos de /api/reportes.
  assert.equal(d.totales.descuento, viejo.descuentos.promo + viejo.descuentos.otros);
  assert.equal(d.totales.descuento, 3000);
  // Canales: tienda + WhatsApp = ventas netas; revendedoras 0.
  assert.equal(d.canales.tienda.ventas + d.canales.whatsapp.ventas + d.canales.revendedoras.ventas, d.totales.ventas);
  assert.equal(d.canales.whatsapp.ventas, 25000);
  assert.equal(d.canales.whatsapp.tickets, 1);
  assert.equal(d.canales.tienda.tickets + d.canales.whatsapp.tickets, d.totales.tickets);
  assert.equal(d.canales.tienda.anterior + d.canales.whatsapp.anterior, d.anterior.ventas);
  // Categorias: suman lo mismo en el periodo y en la comparacion, y son las de /api/reportes.
  assert.equal(suma(d.categorias.map((c: { total: number }) => ({ ventas: c.total }))), d.totales.ventas);
  assert.equal(suma(d.categorias.map((c: { anterior: number }) => ({ ventas: c.anterior }))), d.anterior.ventas);
  assert.deepEqual(d.categorias.map((c: { categoria: string; total: number }) => [c.categoria, c.total]),
    viejo.por_categoria.map((c: { categoria: string; total: number }) => [c.categoria, c.total]));
  assert.deepEqual(d.categorias.map((c: { anterior: number }) => c.anterior), viejo.por_categoria_anterior.map((c: { total: number }) => c.total));
  assert.equal(d.mejor_dia.ventas, Math.max(...viejo.por_dia.map((f: { total: number }) => f.total)));
  assert.equal(d.dias_con_ventas, viejo.por_dia.length);
  // Nada de personas.
  assert.doesNotMatch(JSON.stringify(d), /nadie@prueba|@/);
  t.db.close();
});

test('gastos de operacion: la definicion del tablero (sin inversionistas, un retiro de caja cuenta una vez, nomina pagada)', async () => {
  const t = tienda();
  const hoy = hoyTienda(), ayer = sumarDias(hoy, -1), viejo = sumarDias(hoy, -9);
  const gasto = t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values (?, ?, ?, ?, '', ?, ?, 'x', ?)");
  const ahora = new Date().toISOString();
  gasto.run(crypto.randomUUID(), hoy, 'renta', 50000, 'fuera', null, ahora);
  gasto.run(crypto.randomUUID(), ayer, 'luz', 3000, 'fuera', null, ahora);
  gasto.run(crypto.randomUUID(), ayer, 'inversionistas', 99999, 'fuera', null, ahora);      // reparto: no es operacion
  gasto.run(crypto.randomUUID(), viejo, 'renta', 70000, 'fuera', null, ahora);              // periodo anterior
  const retiro = t.db.prepare("insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria) values (?, 'gasto', 'Caja 1', 'c@prueba.mx', ?, 'm', null, ?, ?)");
  retiro.run('r1', 2000, `${ayer}T18:00:00.000Z`, 'limpieza');                               // solo en retiros
  retiro.run('r2', 1500, `${ayer}T18:00:00.000Z`, 'limpieza');                               // tambien en gastos: una vez
  gasto.run(crypto.randomUUID(), ayer, 'limpieza', 1500, 'caja', 'r2', ahora);
  t.db.prepare("insert into empleados (id, nombre, periodo, pago_dia, creado_en) values ('e1', 'E', 'diario', 30000, '')").run();
  const mov = t.db.prepare("insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, creado_por, creado_en) values (?, 'e1', ?, ?, ?, 'x', ?)");
  mov.run('m1', hoy, 'devengo', 90000, ahora);       // devengado: no es dinero pagado
  mov.run('m2', ayer, 'adelanto', 20000, ahora);
  mov.run('m3', hoy, 'pago', -80000, ahora);
  mov.run('m4', viejo, 'pago', -10000, ahora);       // periodo anterior

  const d = (await resumen(t, 'dias=7')).cuerpo;
  assert.equal(d.totales.gastos, 50000 + 3000 + 2000 + 1500 + 20000 + 80000);
  assert.equal(d.anterior.gastos, 70000 + 10000);
  assert.equal(d.cubetas.find((c: { desde: string }) => c.desde === ayer).gastos, 3000 + 2000 + 1500 + 20000);
  assert.equal(d.cubetas.find((c: { desde: string }) => c.desde === hoy).gastos, 50000 + 80000);
  assert.equal(d.cubetas.reduce((s: number, c: { gastos: number }) => s + c.gastos, 0), d.totales.gastos);
  assert.equal(d.totales.ventas, 0);
  t.db.close();
});

test('periodo vacio, un solo dia y comparacion sin datos se calculan sin romperse', async () => {
  const t = tienda();
  const vacio = (await resumen(t, 'dias=28')).cuerpo;
  assert.equal(vacio.totales.ventas, 0);
  assert.equal(vacio.totales.tickets, 0);
  assert.equal(vacio.cubetas.length, 28);
  assert.equal(vacio.mejor_dia, null);
  assert.equal(vacio.dias_con_ventas, 0);
  assert.deepEqual(vacio.categorias, []);
  assert.equal(vacio.canales.tienda.ventas, 0);
  assert.equal(vacio.canales.mercado_libre.total, 0);
  assert.equal(vacio.meta.monto, null);
  assert.equal(vacio.meta.acumulado, 0);
  assert.equal(vacio.meta.proyeccion, 0);

  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const hoy = hoyTienda();
  await vender(t, hoy);
  const uno = (await resumen(t, 'dias=1')).cuerpo;
  assert.equal(uno.cubetas.length, 1);
  assert.equal(uno.totales.ventas, 25000);
  assert.equal(uno.grano, 'dia');
  assert.equal(uno.anterior.tickets, 0);                    // el dia anterior no tuvo nada: la comparacion existe pero esta vacia
  assert.equal(uno.mejor_dia.ventas, 25000);
  const sin = (await resumen(t, 'dias=1&comparar=ninguna')).cuerpo;
  assert.equal(sin.comparacion, null);
  assert.equal(sin.anterior, null);
  assert.equal(sin.cubetas[0].anterior, null);
  assert.equal(sin.canales.tienda.anterior, null);
  assert.equal(sin.canales.mercado_libre.anterior, null);
  assert.equal(sin.categorias[0].anterior, 0);
  t.db.close();
});

test('un rango pasado y cerrado, que cruza el cambio de mes, por semana y por mes', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  const dias = ['2026-01-29', '2026-01-31', '2026-02-02', '2026-02-03', '2026-02-11'];
  for (const d of dias) await vender(t, d);
  await vender(t, '2026-02-02', {}, 2);
  await vender(t, '2025-12-30');                            // la comparacion un mes atras (30 dic - 2 ene... y fuera del periodo)

  const dia = (await resumen(t, 'desde=2026-01-30&hasta=2026-02-03&comparar=mes')).cuerpo;
  assert.equal(dia.totales.ventas, 25000 + 25000 + 50000 + 25000);       // 31 ene, 2 feb (x2 tickets), 3 feb
  assert.equal(dia.totales.tickets, 4);
  assert.deepEqual(dia.comparacion, { desde: '2025-12-30', hasta: '2026-01-03', dias: 5 });
  assert.equal(dia.anterior.ventas, 25000);                              // 30 dic
  assert.equal(dia.cubetas[0].anterior.ventas, 25000);                   // 30 ene contra 30 dic
  assert.equal(dia.cubetas.length, 5);
  assert.equal(dia.meta_mes, '2026-02');
  assert.equal(dia.meta.dias_mes, 28);
  assert.equal(dia.meta.transcurridos, 3);                               // la meta es del mes de la fecha final, hasta esa fecha
  assert.equal(dia.meta.acumulado, 25000 + 50000 + 25000);               // 2 y 3 de febrero

  const semana = (await resumen(t, 'desde=2026-01-26&hasta=2026-02-15&grano=semana&comparar=anterior')).cuerpo;
  assert.equal(semana.grano, 'semana');
  assert.deepEqual(semana.cubetas.map((c: { desde: string; dias: number }) => [c.desde, c.dias]), [['2026-01-26', 7], ['2026-02-02', 7], ['2026-02-09', 7]]);
  assert.equal(semana.cubetas.every((c: { parcial: boolean }) => !c.parcial), true);
  assert.deepEqual(semana.cubetas.map((c: { ventas: number }) => c.ventas), [50000, 100000, 25000]);
  assert.equal(suma(semana.cubetas), semana.totales.ventas);

  const mes = (await resumen(t, 'desde=2026-01-15&hasta=2026-02-28&grano=mes&comparar=ninguna')).cuerpo;
  assert.deepEqual(mes.cubetas.map((c: { desde: string; dias: number; parcial: boolean }) => [c.desde, c.dias, c.parcial]), [['2026-01-15', 17, true], ['2026-02-01', 28, false]]);
  assert.equal(suma(mes.cubetas), mes.totales.ventas);
  assert.equal(mes.meta.cerrado, true);                                  // febrero entero
  assert.equal(mes.meta.proyeccion, mes.meta.acumulado);
  assert.equal(mes.meta.acumulado, 25000 + 50000 + 25000 + 25000);   // 2 feb (dos tickets), 3 y 11 feb
  // Un grano que el periodo no permite vuelve al automatico.
  assert.equal((await resumen(t, 'desde=2026-02-01&hasta=2026-02-28&grano=mes')).cuerpo.grano, 'dia');
  t.db.close();
});

test('«mismo periodo del mes pasado» para 29 a 31 se queda dentro del mes pasado y conserva el largo', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  await vender(t, '2026-03-30');
  await vender(t, '2026-02-27');
  await vender(t, '2026-02-27');
  await vender(t, '2026-03-02');                            // marzo: fuera de la ventana
  const d = (await resumen(t, 'desde=2026-03-29&hasta=2026-03-31&comparar=mes')).cuerpo;
  assert.deepEqual(d.comparacion, { desde: '2026-02-26', hasta: '2026-02-28', dias: 3 });
  assert.equal(d.anterior.ventas, 50000);
  assert.equal(d.totales.ventas, 25000);
  assert.equal(d.cubetas[1].anterior.ventas, 50000);        // 30 mar contra 27 feb
  t.db.close();
});

test('la meta del mes: monto, acumulado, proyeccion lineal y brecha', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  const hoy = hoyTienda();
  const primero = `${hoy.slice(0, 8)}01`;
  await vender(t, primero, {}, 2);                          // $500
  await vender(t, hoy);                                     // $250
  t.db.prepare("insert into config (clave, valor) values ('meta_ventas_mes', '10000000')").run();
  const d = (await resumen(t, 'dias=1')).cuerpo;            // un dia: la meta no depende del rango
  const transcurridos = Number(hoy.slice(8));
  const diasMes = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), 0)).getUTCDate();
  assert.equal(d.meta.monto, 10_000_000);
  assert.equal(d.meta.transcurridos, transcurridos);
  assert.equal(d.meta.acumulado, 75000);
  assert.equal(d.meta.proyeccion, transcurridos === diasMes ? 75000 : Math.round(75000 * diasMes / transcurridos));
  assert.equal(d.meta.brecha, d.meta.proyeccion - 10_000_000);
  assert.equal(d.meta.acumulado_por_dia.length, transcurridos);
  assert.equal(d.meta.acumulado_por_dia.at(-1), d.meta.acumulado);
  assert.equal(d.totales.ventas, 25000);                    // el periodo es solo hoy
  t.db.close();
});

test('con tienda: gastos, meta y Mercado Libre no se inventan por tienda; los canales y las ventas si se acotan', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  const hoy = hoyTienda();
  await vender(t, hoy);
  const otra = await vender(t, hoy);
  t.db.prepare("update ventas set tienda = 'salk' where id = ?").run(otra);
  t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values ('g1', ?, 'renta', 1000, '', 'fuera', null, 'x', '')").run(hoy);
  const todo = (await resumen(t, 'dias=7')).cuerpo;
  const salk = (await resumen(t, 'dias=7&tienda=salk')).cuerpo;
  assert.equal(todo.totales.ventas, 50000);
  assert.equal(salk.totales.ventas, 25000);
  assert.equal(salk.tienda, 'salk');
  assert.equal(salk.totales.gastos, null);
  assert.equal(salk.anterior.gastos, null);
  assert.equal(salk.cubetas[0].gastos, null);
  assert.deepEqual(salk.meta, { solo_negocio: true });
  assert.equal(salk.canales.mercado_libre, null);
  assert.equal(salk.retiros_sin_clasificar, null);
  assert.equal(todo.totales.gastos, 1000);
  assert.equal(salk.canales.tienda.ventas, 25000);
  assert.equal((await resumen(t, 'dias=7&tienda=narnia')).status, 400);
  t.db.close();
});

test('Mercado Libre va aparte y estimado; periodo y comparacion', async () => {
  const t = tienda();
  const hoy = hoyTienda();
  t.db.prepare("insert into ml_publicaciones (producto_id, ml_item_id, estado, precio_ml, actualizado_en) values (?, 'MLM1', 'activa', 18000, '')").run(PRODUCTO);
  const orden = t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values (?, 'MLM1', ?, ?, ?, 0, ?)");
  orden.run('o1', PRODUCTO, 2, 'descontada', `${hoy}T18:00:00.000Z`);
  orden.run('o2', PRODUCTO, 5, 'cancelada', `${hoy}T18:00:00.000Z`);
  orden.run('o3', PRODUCTO, 1, 'descontada', `${sumarDias(hoy, -8)}T18:00:00.000Z`);       // periodo anterior
  const d = (await resumen(t, 'dias=7')).cuerpo;
  assert.deepEqual(d.canales.mercado_libre, { estimado: true, total: 36000, piezas: 2, piezas_reales: 0, anterior: 18000 });
  assert.equal(d.totales.ventas, 0);                        // no suma a las ventas netas
  t.db.close();
});

test('parametros invalidos y permiso: solo el dueno, y 400 en vez de 500', async () => {
  const t = tienda();
  assert.equal((await resumen(t, 'dias=7&comparar=ayer')).status, 400);
  assert.equal((await resumen(t, 'dias=7&grano=hora')).status, 400);
  assert.equal((await resumen(t, 'desde=2026-02-30&hasta=2026-03-01')).status, 400);
  assert.equal((await resumen(t, `desde=2026-01-01&hasta=${sumarDias(hoyTienda(), 1)}`)).status, 400);
  assert.equal((await resumen(t, 'dias=abc')).status, 200);
  assert.equal((await t.pedir('/api/reportes/resumen', {}, 'POST')).status >= 400, true);
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('caja@prueba.mx', 'C', 'cajero', 1, '', '')").run();
  (t.env as unknown as Record<string, string>).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await resumen(t, 'dias=7')).status, 403);
  (t.env as unknown as Record<string, string>).DEV_USUARIO = DUENO;
  assert.equal((await resumen(t, 'dias=7')).status, 200);
  t.db.close();
});

test('retiros sin clasificar: se cuentan aparte y no cambian los gastos ni el resultado', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  const hoy = hoyTienda(), ayer = sumarDias(hoy, -1), viejo = sumarDias(hoy, -20);
  await vender(t, ayer);
  const sin = (await resumen(t, 'dias=7')).cuerpo;
  assert.deepEqual(sin.retiros_sin_clasificar, { n: 0, importe: 0 });

  const retiro = t.db.prepare("insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria) values (?, ?, 'Caja 1', 'c@prueba.mx', ?, 'm', null, ?, '')");
  retiro.run('s1', 'retiro', 30000, `${ayer}T18:00:00.000Z`);        // cuenta
  retiro.run('s2', 'retiro', 12000, `${hoy}T18:00:00.000Z`);         // cuenta
  retiro.run('s3', 'retiro', 5000, `${viejo}T18:00:00.000Z`);        // fuera del periodo
  retiro.run('s4', 'gasto', 7000, `${ayer}T18:00:00.000Z`);          // gasto de caja: ya esta en los gastos, no es «sin clasificar»
  retiro.run('s5', 'retiro', 9000, `${ayer}T18:00:00.000Z`);         // con fila en gastos: no cuenta
  t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values ('g5', ?, 'limpieza', 9000, '', 'caja', 's5', 'x', '')").run(ayer);
  const antes = sin.totales.gastos;
  const d = (await resumen(t, 'dias=7')).cuerpo;
  assert.deepEqual(d.retiros_sin_clasificar, { n: 2, importe: 42000 });
  assert.equal(d.totales.gastos, antes + 9000 + 7000);              // solo lo clasificado: el gasto de caja y el de limpieza
  assert.equal(d.totales.ventas - d.totales.gastos, 25000 - 16000);   // el resultado tampoco cuenta los retiros sin clasificar
  t.db.close();
});

test('las tarjetas avisan de los retiros sin clasificar solo cuando hay', () => {
  const d: any = {
    ...base(), grano: 'dia', meta_mes: '2026-11', meta: { solo_negocio: true }, retiros_sin_clasificar: { n: 0, importe: 0 },
    cubetas: Array.from({ length: 3 }, (_, i) => ({ desde: `2026-11-0${i + 1}`, hasta: `2026-11-0${i + 1}`, dias: 1, parcial: false, ventas: 1, tickets: 1, piezas: 1, descuento: 0, gastos: 0, anterior: null })),
  };
  const limpio = tarjetasHtml(tarjetasKpi(d, null));
  assert.doesNotMatch(limpio, /sin clasificar/);
  assert.match(limpio, /antes del costo de la mercancía<\/div>/);
  d.retiros_sin_clasificar = { n: 3, importe: 123456 };
  const k = tarjetasKpi(d, null);
  const html = tarjetasHtml(k);
  assert.match(html, /No incluye 3 retiros de caja por \$1,234\.56 sin clasificar \(nómina u otros\)/);
  assert.match(html, /antes del costo de la mercancía y de los retiros sin clasificar/);
  assert.equal(k[5].valor, '$8,000.00');                            // el total de gastos no cambia
  assert.equal(k[6].valor, '$12,000.00');
  d.retiros_sin_clasificar = { n: 1, importe: 500 };
  assert.match(tarjetasHtml(tarjetasKpi(d, null)), /No incluye 1 retiro de caja por \$5\.00/);
  d.retiros_sin_clasificar = null;                                   // con tienda elegida no se pide
  assert.doesNotMatch(tarjetasHtml(tarjetasKpi(d, null)), /sin clasificar/);
});

test('la pantalla habla de dias, semanas y meses, nunca de cubetas', () => {
  assert.equal(unidadGrano('dia', 28), 'días');
  assert.equal(unidadGrano('semana', 1), 'semana');
  assert.equal(unidadGrano('mes', 3), 'meses');
  for (const grano of ['dia', 'semana', 'mes']) {
    const d: any = { ...base(), grano, meta_mes: '2026-11', meta: { solo_negocio: true }, comparar: 'anterior', retiros_sin_clasificar: { n: 1, importe: 100 },
      cubetas: [{ desde: '2026-11-02', hasta: '2026-11-08', dias: 7, parcial: true, ventas: 100, tickets: 1, piezas: 1, descuento: 0, gastos: 0, anterior: { ventas: 50, tickets: 1, piezas: 1, descuento: 0, gastos: 0, dias: 5 } }] };
    const texto = [tarjetasHtml(tarjetasKpi(d, null)), leyendaTendencia(d), tablaTendencia(d), JSON.stringify(datosTendencia(d)), hallazgosHtml(hallazgos(d)), canalesHtmlSeguro(d)].join(' ');
    assert.doesNotMatch(texto, /cubeta/i);
  }
});
const canalesHtmlSeguro = (d: any) => canalesHtml({ ...d, canales: { tienda: { ventas: 1, tickets: 1, anterior: 1 }, whatsapp: { ventas: 0, tickets: 0, anterior: 0 }, revendedoras: { ventas: 0, tickets: 0, anterior: 0 }, mercado_libre: null } });
