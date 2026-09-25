// node --test src/precio.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularPrecio, ajustarManual, redondear5, quebrarDecena, precioDesdeSugerencia, codigoDeDestino, esDestinoBanda, prefijoParaFamilia } from './precio.ts';

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

test('mitad del precio de lista, quebrado al $10 mas cercano menos $1: siempre termina en 9', () => {
  assert.deepEqual(precio(50000), { precio: 24900, destino: 'etiqueta' });   // $500 -> $250 -> $249
  assert.deepEqual(precio(50300), { precio: 24900, destino: 'etiqueta' });   // $503 -> $251.50 -> $250 -> $249
  assert.deepEqual(precio(51000), { precio: 25900, destino: 'etiqueta' });   // $510 -> $255 -> $260 -> $259
  assert.deepEqual(precio(46600), { precio: 22900, destino: 'etiqueta' });   // $466 -> $233 -> $230 -> $229
});

test('una pieza danada baja al 60 % de ese precio', () => {
  assert.deepEqual(precio(100000, 'ropa', 'danado'), { precio: 29900, destino: 'etiqueta' }); // $1000 * 0.3 = $300 -> $299
});

test('toda pieza fotografiada lleva etiqueta, tambien la barata: ya no cae sola a una banda', () => {
  assert.deepEqual(precio(7000), { precio: 3900, destino: 'etiqueta' });   // $70 -> $35 -> $40 -> $39
  assert.deepEqual(precio(3000), { precio: 1900, destino: 'etiqueta' });   // $30 -> $15 -> $20 -> $19
  assert.deepEqual(precio(3000, 'hogar'), { precio: 1900, destino: 'etiqueta' });
  assert.deepEqual(precio(40000), { precio: 19900, destino: 'etiqueta' }); // $400 -> $200 -> $199, con su propia etiqueta
});

test('lo muy barato no baja de $9, ni queda en $0', () => {
  assert.deepEqual(precio(600), { precio: 900, destino: 'etiqueta' });     // $6 -> $3 -> minimo $9
  assert.deepEqual(precio(100), { precio: 500, destino: 'etiqueta' });     // lista $1: el tope del precio de lista (a $5) le gana al minimo
});

test('el precio nunca queda por encima del precio de lista', () => {
  const config200 = { ...config, pct_ropa: '200' };
  const { precio: resultado } = calcularPrecio({
    precioLista: 20000, categoria: 'ropa', estadoFisico: 'nuevo', config: config200,
  });
  assert.equal(resultado, 20000);
});

test('una categoria desconocida usa el porcentaje de otros', () => {
  assert.deepEqual(precio(100000, 'ferreteria'), { precio: 49900, destino: 'etiqueta' });
});

test('sin precio de lista la pieza espera al admin, no se queda en el minimo', () => {
  assert.deepEqual(precio(0), { precio: 0, destino: 'etiqueta' });
});

test('la sugerencia del modelo pasa por las mismas guardas', () => {
  const desde = (precioLista: number, sugerido: number) => precioDesdeSugerencia({ precioLista, sugerido });

  // El ventilador: lista $350 y el modelo propone los $250 que cobra Isaac.
  assert.deepEqual(desde(35000, 25000), { precio: 24900, destino: 'etiqueta' });
  // Al $10 mas cercano menos $1: 242 -> 240 -> 239, 246 -> 250 -> 249.
  assert.equal(desde(35000, 24200).precio, 23900);
  assert.equal(desde(35000, 24600).precio, 24900);
  // Nunca por encima del precio de lista, aunque el modelo se pase.
  assert.equal(desde(10000, 50000).precio, 10000);
  // Lo barato tambien lleva etiqueta.
  assert.deepEqual(desde(12000, 4000), { precio: 3900, destino: 'etiqueta' });
  // Sin sugerencia, el que llama usa el porcentaje.
  assert.deepEqual(desde(35000, 0), { precio: 0, destino: 'etiqueta' });
});

test('una pieza de banda se vende al precio de la banda, no al que se tecleo', () => {
  // El caso real: algo en banda_g199 con $40 escrito a mano.
  assert.equal(ajustarManual({ precio: 4000, destino: 'banda_g199', config }), 19900);
  assert.equal(ajustarManual({ precio: 4000, destino: 'banda_g49', config }), 4900);
  assert.equal(ajustarManual({ precio: 9999, destino: 'banda_r19', config }), 1900);
});

test('un precio escrito a mano tambien quiebra la decena', () => {
  assert.equal(ajustarManual({ precio: 25000, destino: 'etiqueta', config }), 24900);
  assert.equal(ajustarManual({ precio: 24900, destino: 'etiqueta', config }), 24900);   // idempotente
  assert.equal(ajustarManual({ precio: 7200, destino: 'etiqueta', config }), 6900);   // 72 -> 70 -> 69
  assert.equal(ajustarManual({ precio: 0, destino: 'etiqueta', config }), 0);
  assert.equal(quebrarDecena(23300), 22900);   // $233 baja
  assert.equal(quebrarDecena(23500), 23900);   // $235 sube
  assert.equal(quebrarDecena(23499), 22900);   // $234.99 todavia baja
  assert.equal(quebrarDecena(30100), 29900);
  assert.equal(quebrarDecena(400), 900);       // minimo $9
  assert.equal(quebrarDecena(0), 0);
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
