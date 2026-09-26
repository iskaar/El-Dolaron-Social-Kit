// node --test src/impresora.test.ts
// Solo la parte de texto del ticket: el envio por WebUSB necesita hardware real
// y no se puede probar aqui (ver el issue #32 para la validacion fisica).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinAcentos, centrarTexto, renglonMontoTexto, explicarErrorUsb, rasterEscPos, COLUMNAS } from '../public/impresora.js';

test('sinAcentos quita acentos y enye, sin romper el resto del texto', () => {
  assert.equal(sinAcentos('Almohada azúl, Peña'), 'Almohada azul, Pena');
});

test('sinAcentos cambia lo que no es ASCII por "?", en vez de mandarlo tal cual', () => {
  assert.equal(sinAcentos('日本語'), '???');
});

test('centrarTexto reparte el espacio sobrante a los lados', () => {
  const resultado = centrarTexto('EL DOLARON');
  assert.equal(resultado.length, Math.floor((COLUMNAS - 'EL DOLARON'.length) / 2) + 'EL DOLARON'.length);
  assert.ok(resultado.startsWith(' '.repeat(Math.floor((COLUMNAS - 'EL DOLARON'.length) / 2))));
});

test('centrarTexto con texto mas largo que el papel no lo recorta ni truena', () => {
  const largo = 'x'.repeat(COLUMNAS + 10);
  assert.equal(centrarTexto(largo), largo);
});

test('renglonMontoTexto llena el ancho completo del papel', () => {
  const resultado = renglonMontoTexto('TOTAL', '$150.00');
  assert.equal(resultado.length, COLUMNAS);
  assert.ok(resultado.startsWith('TOTAL'));
  assert.ok(resultado.endsWith('$150.00'));
});

test('renglonMontoTexto dejando un espacio minimo si etiqueta y monto no caben', () => {
  const etiqueta = 'x'.repeat(COLUMNAS);
  const resultado = renglonMontoTexto(etiqueta, '$1.00');
  assert.equal(resultado, `${etiqueta} $1.00`);
});

test('explicarErrorUsb siempre trae el error real; Access denied y NetworkError agregan que hacer', () => {
  const denegado = explicarErrorUsb({ name: 'SecurityError', message: 'Access denied.' });
  assert.ok(denegado.startsWith('SecurityError: Access denied.') && denegado.includes('WinUSB'));
  assert.ok(explicarErrorUsb({ name: 'NetworkError', message: 'Unable to claim interface.' }).includes('Otra pestaña'));
  assert.equal(explicarErrorUsb({ name: 'InvalidStateError', message: 'x' }), 'InvalidStateError: x');
});

test('rasterEscPos: encabezado GS v 0 y un bit por punto, oscuro = 1, transparente = blanco', () => {
  // 10 x 2: renglon 0 negro en x=0 y x=9; renglon 1 negro en x=1 pero transparente.
  const ancho = 10;
  const alto = 2;
  const rgba = new Uint8ClampedArray(ancho * alto * 4).fill(255);
  const pintar = (x: number, y: number, alfa = 255) => rgba.set([0, 0, 0, alfa], (y * ancho + x) * 4);
  pintar(0, 0);
  pintar(9, 0);
  pintar(1, 1, 0);
  const bytes = rasterEscPos(rgba, ancho, alto);
  assert.deepEqual([...bytes.slice(0, 8)], [0x1d, 0x76, 0x30, 0, 2, 0, 2, 0]);   // 2 bytes por renglon, 2 renglones
  assert.deepEqual([...bytes.slice(8)], [0b10000000, 0b01000000, 0, 0]);
});
