// node --test src/graficas.test.ts
// Dinero al centavo, escalas y cuadre de /reportes (Issue #166): lo que no toca el DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pesos, dolarones, pesosEje, pesosConSigno, escala, cambio, rellenarDias, textoPeriodo, verificarCuadre } from '../public/graficas.js';
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
});
