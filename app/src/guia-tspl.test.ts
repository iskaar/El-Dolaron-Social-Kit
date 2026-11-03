import test from 'node:test';
import assert from 'node:assert/strict';
import { tsplDeImagen, cajaDeTinta, TSPL_CALIBRAR_GUIA } from '../public/guia-tspl.js';

// Imagen RGBA de `ancho` × `alto` en blanco, con los puntos dados en negro.
function imagen(ancho: number, alto: number, negros: Array<[number, number]>) {
  const rgba = new Uint8ClampedArray(ancho * alto * 4).fill(255);
  for (const [x, y] of negros) rgba.fill(0, (y * ancho + x) * 4, (y * ancho + x) * 4 + 3);
  return rgba;
}
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

test('guía → TSPL BITMAP (#691): 100 × 150 mm, bit 0 = negro, franjas blancas fuera, PRINT al final', () => {
  // 16 × 40: un punto en (0,0) y otro en (9,1); de la fila 2 a la 39 todo blanco salvo (15,39).
  const tspl = tsplDeImagen(imagen(16, 40, [[0, 0], [9, 1], [15, 39]]), 16, 40);
  const s = latin1(tspl);
  assert.ok(s.startsWith('SIZE 100 mm,150 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\n'));
  assert.ok(s.endsWith('PRINT 1,1\r\n'));
  // Dos franjas: filas 0–1 y fila 39 (el hueco de 37 filas pasa de 16 y se parte).
  const bitmaps = [...s.matchAll(/BITMAP 0,(\d+),(\d+),(\d+),0,/g)].map((m) => m.slice(1).map(Number));
  assert.deepEqual(bitmaps, [[0, 2, 2], [39, 2, 1]]);
  const i = s.indexOf('BITMAP 0,0,2,2,0,') + 'BITMAP 0,0,2,2,0,'.length;
  assert.deepEqual([...tspl.slice(i, i + 4)], [0b01111111, 0xff, 0xff, 0b10111111]);
});

test('guía → TSPL: huecos cortos quedan dentro del mismo BITMAP; invertir voltea la polaridad', () => {
  const s = latin1(tsplDeImagen(imagen(8, 10, [[0, 0], [0, 5]]), 8, 10));
  assert.deepEqual([...s.matchAll(/BITMAP 0,(\d+),(\d+),(\d+),0,/g)].map((m) => m.slice(1).map(Number)), [[0, 1, 6]]);
  const inv = tsplDeImagen(imagen(8, 1, [[7, 0]]), 8, 1, { invertir: true });
  const j = latin1(inv).indexOf('BITMAP 0,0,1,1,0,') + 'BITMAP 0,0,1,1,0,'.length;
  assert.equal(inv[j], 0b00000001);
  assert.ok(!latin1(tsplDeImagen(imagen(8, 4, []), 8, 4)).includes('BITMAP'), 'una guía en blanco no manda mapa');
});

test('cajaDeTinta (#691): recuadro de lo impreso dentro de la hoja; en blanco da null', () => {
  assert.deepEqual(cajaDeTinta(imagen(20, 10, [[3, 2], [12, 7]]), 20, 10), { x: 3, y: 2, ancho: 10, alto: 6 });
  assert.equal(cajaDeTinta(imagen(5, 5, []), 5, 5), null);
});

test('calibrar el rollo de guías (#691): misma medida que la guía y GAPDETECT', () => {
  assert.equal(TSPL_CALIBRAR_GUIA, ['SIZE 100 mm,150 mm', 'GAP 2 mm,0 mm', 'GAPDETECT', ''].join(String.fromCharCode(13, 10)));
});
