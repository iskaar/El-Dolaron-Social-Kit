// node --test src/camara.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { lecturaNueva } from '../public/camara.js';

test('la primera lectura cuenta', () => {
  assert.equal(lecturaNueva(null, 'ED-000001', 1000), true);
});

test('el mismo codigo en cuadros seguidos no se repite', () => {
  assert.equal(lecturaNueva({ codigo: 'ED-000001', en: 1000 }, 'ED-000001', 1100), false);
  assert.equal(lecturaNueva({ codigo: 'ED-000001', en: 1000 }, 'ED-000001', 3499), false);
});

test('pasada la ventana, el mismo codigo cuenta otra vez (bandas en cantidad)', () => {
  assert.equal(lecturaNueva({ codigo: 'G19', en: 1000 }, 'G19', 3500), true);
});

test('otro codigo cuenta de inmediato', () => {
  assert.equal(lecturaNueva({ codigo: 'ED-000001', en: 1000 }, 'ED-000002', 1010), true);
});
