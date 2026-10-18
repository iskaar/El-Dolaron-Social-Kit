import test from 'node:test';
import assert from 'node:assert/strict';
import { PRECIO_PRENDA, PRENDAS_ROPA } from '../public/ropa.js';

test('precios sugeridos por prenda en centavos', () => {
  assert.deepEqual(PRECIO_PRENDA, {
    Playera: 10000, Blusa: 10000,
    Camisa: 15000, Vestido: 15000, Falda: 15000, Short: 15000, 'Traje de baño': 15000,
    Sudadera: 20000, Suéter: 20000, Jeans: 20000, Pantalón: 20000, Pants: 20000,
    Leggings: 20000, Pijama: 20000, Conjunto: 20000, Chamarra: 30000,
  });
  assert.deepEqual(Object.keys(PRECIO_PRENDA).sort(), [...PRENDAS_ROPA].sort());
});
