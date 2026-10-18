// node --test src/precios-ml.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { enlacePreciosML } from '../public/precios-ml.js';

test('enlacePreciosML: slug sin acentos ni apostrofos y marca solo si falta', () => {
  const ml = 'https://listado.mercadolibre.com.mx/';
  assert.equal(enlacePreciosML('SplatRball 800 Pyro Blaster Kit', 'Splat R Ball'), `${ml}splat-r-ball-splatrball-800-pyro-blaster-kit`);
  assert.equal(enlacePreciosML("Jeans Levi's 501", "Levi's"), `${ml}jeans-levis-501`);
  assert.equal(enlacePreciosML('  Pantalón   Dama ', ''), `${ml}pantalon-dama`);
  assert.equal(enlacePreciosML('Suéter', 'Ñandú'), `${ml}nandu-sueter`);
  assert.equal(enlacePreciosML('', 'Nike'), '');
  assert.equal(enlacePreciosML('¿?', ''), '');
});
