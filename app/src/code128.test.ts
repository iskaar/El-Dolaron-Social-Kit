// node --test src/code128.test.ts
// La prueba de verdad es el lector leyendo papel; esto solo evita el error tonto
// que llegaria hasta la impresora.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchos, svgCode128 } from '../public/code128.js';

const INICIO_B = '211214'; // valor 104. El 103 ('211412') es el inicio A.
const PARADA = '2331112';

test('arranca y termina con los patrones fijos de Code128-B', () => {
  const secuencia = anchos('ED-000123');
  assert.ok(secuencia.startsWith(INICIO_B), 'falta el patron de inicio B');
  assert.ok(secuencia.endsWith(PARADA), 'falta el patron de parada');
});

test('largo: inicio + datos + control + parada', () => {
  const texto = 'ED-000123';
  // 6 modulos por simbolo, 7 en la parada.
  assert.equal(anchos(texto).length, 6 * (texto.length + 2) + 7);
});

test('el digito de control depende del contenido y de la posicion', () => {
  // 'A' vale 33: (104 + 33*1) % 103 = 34, cuyo patron es '131123'.
  const control = anchos('A').slice(12, 18);
  assert.equal(control, '131123');
  // Mismos caracteres en otro orden: otro control.
  assert.notEqual(anchos('AB'), anchos('BA'));
});

test('los milimetros del SVG salen de la suma de anchos', () => {
  const svg = svgCode128('ED-000001', { modulo: 0.33, alto: 12 });
  const suma = [...anchos('ED-000001')].reduce((total, d) => total + Number(d), 0);
  const esperado = (suma * 0.33 + 20 * 0.33).toFixed(2); // + zona muda a los dos lados
  assert.ok(svg.includes(`width="${esperado}mm"`), `ancho inesperado en ${svg.slice(0, 120)}`);
  assert.ok(svg.includes('height="12mm"'));
});

test('rechaza lo que Code128-B no puede representar', () => {
  assert.throws(() => anchos('ñ'), /fuera de Code128-B/);
});
