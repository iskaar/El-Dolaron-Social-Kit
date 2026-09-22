// node --test src/etiquetera.test.ts
// Solo el trabajo TSPL: el envio por BLE necesita la impresora enfrente y no se
// puede probar aqui. Lo que si se puede es que el texto salga dentro de la
// etiqueta, que es donde se rompio todo lo anterior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tsplEtiqueta, partirNombre, NOMBRE_MAX } from '../public/etiquetera.js';

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
