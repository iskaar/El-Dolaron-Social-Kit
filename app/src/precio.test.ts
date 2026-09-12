// node --test src/precio.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularPrecio, ajustarManual, redondear5 } from './precio.ts';

// Los valores confirmados por Isaac (2026-09-11).
const config = {
  pct_ropa: '50', pct_hogar: '50', pct_electronica: '50', pct_juguetes: '50', pct_otros: '50',
  pct_danado: '60', limite_bin: '6000', bin_20: '2000', bin_40: '4000', bin_60: '6000',
};

const precio = (precioLista: number, categoria = 'ropa', estadoFisico = 'nuevo') =>
  calcularPrecio({ precioLista, categoria, estadoFisico, config });

test('mitad del precio de lista, redondeado hacia arriba a $5', () => {
  assert.deepEqual(precio(30000), { precio: 15000, destino: 'etiqueta' });   // $300 -> $150
  assert.deepEqual(precio(30300), { precio: 15500, destino: 'etiqueta' });   // $303 -> $151.50 -> $155
});

test('una pieza danada baja al 60 % de ese precio', () => {
  assert.deepEqual(precio(30000, 'ropa', 'danado'), { precio: 9000, destino: 'etiqueta' });
});

test('lo barato cae al bin mas chico que lo cubra, sin etiqueta', () => {
  assert.deepEqual(precio(3000), { precio: 2000, destino: 'bin_20' });   // $15 -> bin $20
  assert.deepEqual(precio(7000), { precio: 4000, destino: 'bin_40' });   // $35 -> bin $40
  assert.deepEqual(precio(11000), { precio: 6000, destino: 'bin_60' });  // $55 -> bin $60
  assert.deepEqual(precio(12000), { precio: 6000, destino: 'bin_60' });  // $60 justo: sigue siendo bin
  assert.equal(precio(13000).destino, 'etiqueta');                       // $65 -> ya lleva etiqueta
});

test('el precio nunca queda por encima del precio de lista', () => {
  const config200 = { ...config, pct_ropa: '200' };
  const { precio: resultado } = calcularPrecio({
    precioLista: 20000, categoria: 'ropa', estadoFisico: 'nuevo', config: config200,
  });
  assert.equal(resultado, 20000);
});

test('una categoria desconocida usa el porcentaje de otros', () => {
  assert.deepEqual(precio(30000, 'ferreteria'), { precio: 15000, destino: 'etiqueta' });
});

test('sin precio de lista la pieza espera al admin, no cae al bin mas barato', () => {
  assert.deepEqual(precio(0), { precio: 0, destino: 'etiqueta' });
});

test('una pieza de bin se vende al precio del bote, no al que se tecleo', () => {
  // El caso real: bandas de cabello en bin_60 con $40 escrito a mano.
  assert.equal(ajustarManual({ precio: 4000, destino: 'bin_60', config }), 6000);
  assert.equal(ajustarManual({ precio: 4000, destino: 'bin_40', config }), 4000);
  assert.equal(ajustarManual({ precio: 9999, destino: 'bin_20', config }), 2000);
});

test('un precio escrito a mano tambien se redondea a $5', () => {
  assert.equal(ajustarManual({ precio: 7200, destino: 'etiqueta', config }), 7500);
  assert.equal(redondear5(7500), 7500);
  assert.equal(redondear5(1), 500);
  assert.equal(redondear5(0), 0);
});
