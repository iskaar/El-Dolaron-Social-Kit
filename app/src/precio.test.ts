// node --test src/precio.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularPrecio, ajustarManual, redondear5, precioDesdeSugerencia, codigoDeDestino, esDestinoBanda, prefijoParaFamilia } from './precio.ts';

// Los valores confirmados por Isaac: porcentajes 2026-09-11, bandas 2026-09-24
// (limite subido a $200, ropa/general comparten los siete precios).
const config = {
  pct_ropa: '50', pct_hogar: '50', pct_electronica: '50', pct_juguetes: '50', pct_otros: '50',
  pct_danado: '60', limite_banda: '20000',
  banda_19: '1900', banda_29: '2900', banda_49: '4900', banda_79: '7900',
  banda_99: '9900', banda_149: '14900', banda_199: '19900',
};

const precio = (precioLista: number, categoria = 'ropa', estadoFisico = 'nuevo') =>
  calcularPrecio({ precioLista, categoria, estadoFisico, config });

test('mitad del precio de lista, redondeado hacia arriba a $5, por encima del limite lleva etiqueta', () => {
  assert.deepEqual(precio(50000), { precio: 25000, destino: 'etiqueta' });   // $500 -> $250
  assert.deepEqual(precio(50300), { precio: 25500, destino: 'etiqueta' });   // $503 -> $251.50 -> $255
});

test('una pieza danada baja al 60 % de ese precio', () => {
  assert.deepEqual(precio(100000, 'ropa', 'danado'), { precio: 30000, destino: 'etiqueta' }); // $1000 * 0.3
});

test('lo barato cae a la banda mas chica que lo cubra, sin etiqueta individual', () => {
  assert.deepEqual(precio(3000), { precio: 1900, destino: 'banda_r19' });   // $15 -> R19
  assert.deepEqual(precio(7000), { precio: 4900, destino: 'banda_r49' });   // $35 -> R49
  assert.deepEqual(precio(11000), { precio: 7900, destino: 'banda_r79' });  // $55 -> R79
  assert.deepEqual(precio(3000, 'hogar'), { precio: 1900, destino: 'banda_g19' }); // familia general
});

test('$200 justo: sigue en banda, sin banda que lo cubra exacto cae en la mas alta', () => {
  assert.deepEqual(precio(40000), { precio: 19900, destino: 'banda_r199' }); // $400 * 0.5 = $200 justo
  assert.equal(precio(40100).destino, 'etiqueta'); // un peso mas de lista ya se sale del limite
});

test('el precio nunca queda por encima del precio de lista', () => {
  const config200 = { ...config, pct_ropa: '200' };
  const { precio: resultado } = calcularPrecio({
    precioLista: 20000, categoria: 'ropa', estadoFisico: 'nuevo', config: config200,
  });
  assert.equal(resultado, 20000);
});

test('una categoria desconocida usa el porcentaje de otros y cae en la familia general', () => {
  assert.equal(precio(100000, 'ferreteria').destino, 'etiqueta');
  assert.equal(precio(3000, 'ferreteria').destino, 'banda_g19');
});

test('sin precio de lista la pieza espera al admin, no cae a la banda mas barata', () => {
  assert.deepEqual(precio(0), { precio: 0, destino: 'etiqueta' });
});

test('la sugerencia del modelo pasa por las mismas guardas', () => {
  const desde = (precioLista: number, sugerido: number, categoria = 'ropa') =>
    precioDesdeSugerencia({ precioLista, sugerido, categoria, config });

  // El ventilador: lista $350 y el modelo propone los $250 que cobra Isaac.
  assert.deepEqual(desde(35000, 25000), { precio: 25000, destino: 'etiqueta' });
  // Redondeo a $5.
  assert.equal(desde(35000, 24200).precio, 24500);
  // Nunca por encima del precio de lista, aunque el modelo se pase.
  assert.equal(desde(10000, 50000).precio, 10000);
  // Barato: a la banda que lo cubre, no a la etiqueta ni al monto exacto tecleado.
  assert.deepEqual(desde(12000, 4000), { precio: 4900, destino: 'banda_r49' });
  // Sin sugerencia, el que llama usa el porcentaje.
  assert.deepEqual(desde(35000, 0), { precio: 0, destino: 'etiqueta' });
});

test('una pieza de banda se vende al precio de la banda, no al que se tecleo', () => {
  // El caso real: algo en banda_g199 con $40 escrito a mano.
  assert.equal(ajustarManual({ precio: 4000, destino: 'banda_g199', config }), 19900);
  assert.equal(ajustarManual({ precio: 4000, destino: 'banda_g49', config }), 4900);
  assert.equal(ajustarManual({ precio: 9999, destino: 'banda_r19', config }), 1900);
});

test('un precio escrito a mano tambien se redondea a $5', () => {
  assert.equal(ajustarManual({ precio: 7200, destino: 'etiqueta', config }), 7500);
  assert.equal(redondear5(7500), 7500);
  assert.equal(redondear5(1), 500);
  assert.equal(redondear5(0), 0);
});

test('codigoDeDestino da el codigo impreso de la banda, o nulo para etiqueta', () => {
  assert.equal(codigoDeDestino('banda_g79'), 'G79');
  assert.equal(codigoDeDestino('banda_r199'), 'R199');
  assert.equal(codigoDeDestino('etiqueta'), null);
});

test('destinos de banda: cualquier familia de 1 o 2 letras con uno de los siete montos', () => {
  assert.ok(esDestinoBanda('banda_r49'));
  assert.ok(esDestinoBanda('banda_ju199'));
  assert.ok(!esDestinoBanda('banda_ju50'));      // monto que no es de banda
  assert.ok(!esDestinoBanda('banda_abc49'));     // prefijo de 3 letras
  assert.ok(!esDestinoBanda('etiqueta'));
  assert.equal(codigoDeDestino('banda_ju79'), 'JU79');
  assert.equal(ajustarManual({ precio: 123, destino: 'banda_ju49', config: {} }), 4900);
});

test('prefijoParaFamilia: dos primeras letras, y cuando estan ocupadas la primera y la siguiente libre', () => {
  assert.equal(prefijoParaFamilia('Juguetes', new Set()), 'ju');
  assert.equal(prefijoParaFamilia('Electrónica ligera', new Set(['el'])), 'ec');
  assert.equal(prefijoParaFamilia('Mascotas', new Set(['ma'])), 'ms');
  assert.equal(prefijoParaFamilia('Edición', new Set()), 'ei');   // "ed" es de las piezas ED-000123
  assert.equal(prefijoParaFamilia('12', new Set()), null);
});
