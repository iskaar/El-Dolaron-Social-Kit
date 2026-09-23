// node --test src/etiquetera.test.ts
// Solo el trabajo TSPL: el envio por BLE necesita la impresora enfrente y no se
// puede probar aqui. Lo que si se puede es que el texto salga dentro de la
// etiqueta, que es donde se rompio todo lo anterior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tsplEtiqueta, partirNombre, NOMBRE_MAX, TSPL_REGLA, TSPL_CALIBRAR } from '../public/etiquetera.js';

const PIEZA = {
  nombre: 'Taza de ceramica azul',
  precio: 12000,
  precio_lista: 19900,
  codigo: 'ED-000123',
  semana_ingreso: '2026-S38',
};

test('el trabajo abre con el tamano de la etiqueta y cierra imprimiendo', () => {
  const tspl = tsplEtiqueta(PIEZA);
  assert.ok(tspl.startsWith('SIZE 50.8 mm,25.4 mm\r\n'));
  assert.ok(tspl.includes('\r\nCLS\r\n'));
  assert.ok(tspl.trimEnd().endsWith('PRINT 1,1'));
});

test('las existencias se imprimen como copias, no como trabajos repetidos', () => {
  const tspl = tsplEtiqueta(PIEZA, 5);
  assert.ok(tspl.trimEnd().endsWith('PRINT 5,1'));
  assert.equal(tspl.match(/^PRINT /gm)?.length, 1);
});

test('el precio va en pesos redondeados, no en centavos', () => {
  assert.ok(tsplEtiqueta(PIEZA).includes('"$120"'));
});

test('el precio de lista se tacha con una barra encima', () => {
  const tspl = tsplEtiqueta(PIEZA);
  assert.ok(tspl.includes('"$199"'));
  assert.ok(/^BAR \d+,\d+,\d+,2$/m.test(tspl));
});

test('sin precio de lista mayor no hay tachado', () => {
  const tspl = tsplEtiqueta({ ...PIEZA, precio_lista: 12000 });
  assert.ok(!tspl.includes('BAR '));
});

test('la barra codifica el numero sin "ED-" ni ceros, como lo espera la caja', () => {
  assert.ok(tsplEtiqueta(PIEZA).includes(',"128",48,0,0,2,4,"123"'));
  assert.ok(tsplEtiqueta(PIEZA).includes('"ED-000123 - 2026-S38"'));
});

test('el corrimiento de calibracion baja todo el contenido igual', () => {
  const sin = tsplEtiqueta(PIEZA, 1, 0);
  const con = tsplEtiqueta(PIEZA, 1, 40);
  const ys = (tspl: string) =>
    [...tspl.matchAll(/^(?:TEXT|BAR|BARCODE) \d+,(\d+),/gm)].map(([, y]) => Number(y));
  assert.deepEqual(ys(con), ys(sin).map((y) => y + 40));
});

test('un corrimiento negativo no saca el contenido por arriba de la etiqueta', () => {
  const tspl = tsplEtiqueta(PIEZA, 1, -500);
  for (const [, y] of tspl.matchAll(/^(?:TEXT|BAR|BARCODE) \d+,(-?\d+),/gm)) {
    assert.ok(Number(y) >= 0, `coordenada y negativa: ${y}`);
  }
});

test('sin calibrar, el corrimiento es cero: no hay numero inventado', () => {
  assert.equal(tsplEtiqueta(PIEZA), tsplEtiqueta(PIEZA, 1, 0));
});

test('nada se sale del ancho de la etiqueta', () => {
  const largo = tsplEtiqueta({ ...PIEZA, nombre: 'Palabra '.repeat(20), precio: 999900 });
  for (const [, x] of largo.matchAll(/^(?:TEXT|BAR|BARCODE) (\d+),/gm)) {
    assert.ok(Number(x) < 406, `coordenada x fuera de la etiqueta: ${x}`);
  }
});

test('las comillas del nombre no parten el comando TEXT en dos', () => {
  const tspl = tsplEtiqueta({ ...PIEZA, nombre: 'Playera 24" azul' });
  for (const linea of tspl.split('\r\n').filter((l) => l.startsWith('TEXT'))) {
    assert.equal(linea.match(/"/g)?.length, 4, `comillas desbalanceadas: ${linea}`);
  }
});

test('los acentos se quitan: la fuente de la impresora no los tiene', () => {
  assert.ok(tsplEtiqueta({ ...PIEZA, nombre: 'Muñeca de peluche' }).includes('Muneca'));
});

test('partirNombre usa dos renglones y no rebasa el ancho', () => {
  const renglones = partirNombre('Cobija matrimonial de invierno color gris jaspeado');
  assert.equal(renglones.length, 2);
  for (const r of renglones) assert.ok(r.length <= NOMBRE_MAX);
});

test('partirNombre corta con ".." lo que no cabe en dos renglones', () => {
  const renglones = partirNombre('palabra '.repeat(30));
  assert.equal(renglones.length, 2);
  assert.ok(renglones[1].endsWith('..'));
});

test('partirNombre parte una sola palabra larguisima en vez de dejarla salirse', () => {
  const [primero] = partirNombre('x'.repeat(NOMBRE_MAX + 20));
  assert.equal(primero.length, NOMBRE_MAX);
});

test('partirNombre nunca devuelve vacio: una etiqueta sin nombre sigue siendo imprimible', () => {
  assert.deepEqual(partirNombre('   '), ['El Dolaron']);
});

test('la calibracion le pide a la impresora que mida el rollo', () => {
  assert.ok(TSPL_CALIBRAR.includes('GAPDETECT'));
  assert.ok(TSPL_CALIBRAR.startsWith('SIZE 50.8 mm,25.4 mm'));
});

test('la regla marca cada 2 mm hasta cubrir la etiqueta', () => {
  const rayas = [...TSPL_REGLA.matchAll(/^BAR 0,(\d+),120,2$/gm)].map(([, y]) => Number(y));
  assert.deepEqual(rayas, Array.from({ length: 13 }, (_, i) => i * 16));
  assert.ok(TSPL_REGLA.includes('"24 mm"'));
  // El marco es la referencia: sin el no se sabe donde cree la impresora que
  // esta la etiqueta, que es justo lo que se esta midiendo.
  assert.ok(TSPL_REGLA.includes('BOX 0,0,405,202,2'));
});
