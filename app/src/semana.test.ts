// node --test src/semana.test.ts
// La semana de ingreso va impresa en la etiqueta y no se puede corregir despues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { semanaIngreso } from '../public/semana.js';

test('semana ISO', () => {
  assert.equal(semanaIngreso(new Date('2026-09-11T00:00:00Z')), 'S37');
  assert.equal(semanaIngreso(new Date('2026-01-01T00:00:00Z')), 'S01');
  // 2026-12-31 es jueves: semana 53 de 2026, no semana 1 de 2027.
  assert.equal(semanaIngreso(new Date('2026-12-31T00:00:00Z')), 'S53');
  // 2027-01-01 es viernes: sigue siendo la semana 53 de 2026.
  assert.equal(semanaIngreso(new Date('2027-01-01T00:00:00Z')), 'S53');
  // Domingo: pertenece a la semana que termina, no a la que empieza.
  assert.equal(semanaIngreso(new Date('2026-09-13T23:59:00Z')), 'S37');
  // 00:00 UTC del lunes es el domingo 18:00 en Mexico: todavia S37.
  assert.equal(semanaIngreso(new Date('2026-09-14T00:00:00Z')), 'S37');
});

test('la semana se cuenta en hora de la tienda (UTC-6): el domingo de noche sigue en su semana', () => {
  // Domingo 13/9 a las 19:00 en Mexico (= 01:00 UTC del lunes): sigue en la S37.
  assert.equal(semanaIngreso(new Date('2026-09-14T01:00:00Z')), 'S37');
  // Lunes 14/9 a las 00:00 en Mexico (= 06:00 UTC): ya es la S38.
  assert.equal(semanaIngreso(new Date('2026-09-14T06:00:00Z')), 'S38');
});
