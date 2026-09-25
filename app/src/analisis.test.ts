// node --test src/analisis.test.ts
// Solo lo puro: el prompt de familias y la validacion de lo que contesta el modelo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bloqueFamilias, normalizar } from './analisis.ts';

const familias = [
  { clave: 'ropa', nombre: 'Ropa', prefijo: 'r' },
  { clave: 'juguetes', nombre: 'Juguetes', prefijo: 'ju' },
  { clave: 'pilas', nombre: 'Electrónica y pilas', prefijo: 'ee' },   // dada de alta desde /bandas: sin pista
];

test('el bloque de familias lista la clave con su pista, o con el nombre si no hay pista', () => {
  const bloque = bloqueFamilias(familias);
  assert.ok(bloque.includes('- ropa: ropa y accesorios para vestir'));
  assert.ok(bloque.includes('- juguetes: juguetes'));
  assert.ok(bloque.includes('- pilas: Electrónica y pilas'));
  assert.ok(bloque.includes('"general"'));
});

test('una familia que el modelo invento se descarta, y una valida se conserva', () => {
  const claves = familias.map((f) => f.clave);
  const cruda = { nombre: 'Oso', categoria: 'juguetes', precio_lista_mxn: 100, precio_venta_mxn: 0, confianza: 0.9 };
  assert.equal(normalizar({ ...cruda, familia: 'juguetes' }, claves).familia, 'juguetes');
  assert.equal(normalizar({ ...cruda, familia: 'botadero' }, claves).familia, '');
  assert.equal(normalizar({ ...cruda, familia: 'inventada' }, claves).familia, '');
  assert.equal(normalizar(cruda, claves).familia, '');
});
