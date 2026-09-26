// node --test src/sesiones.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { agruparSesiones } from '../public/sesiones.js';

const pieza = (id: string, quien: string, hora: string) => ({ id, capturado_por: quien, creado_en: `2026-09-25T${hora}:00.000Z` });

test('una pausa larga parte la sesion; dos personas a la vez son dos sesiones', () => {
  const { porPieza, sesiones } = agruparSesiones([
    pieza('c', 'ana', '18:20'),   // desordenadas a proposito
    pieza('a', 'ana', '18:00'),
    pieza('b', 'ana', '18:10'),
    pieza('x', 'beto', '18:05'),
    pieza('d', 'ana', '19:30'),   // 70 min despues: otra sesion
  ]);
  assert.equal(sesiones.length, 3);
  assert.equal(porPieza.get('a'), porPieza.get('c'));
  assert.notEqual(porPieza.get('c'), porPieza.get('d'));
  assert.notEqual(porPieza.get('a'), porPieza.get('x'));
  // Lo mas nuevo primero, con su rango y conteo.
  assert.deepEqual(sesiones.map((s) => [s.quien, s.piezas]), [['ana', 1], ['beto', 1], ['ana', 3]]);
  assert.equal(sesiones[2].fin, '2026-09-25T18:20:00.000Z');
});
