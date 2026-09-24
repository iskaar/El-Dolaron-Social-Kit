// node --test src/venta.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { totales, agregar, efectivoAlcanza } from '../public/venta.js';

interface Linea { codigo: string; nombre: string; precio: number; cantidad: number }
const pieza = (codigo: string, precio: number) => ({ codigo, nombre: codigo, precio });

test('el total suma precio por cantidad', () => {
  const lineas: Linea[] = [
    { codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 },
    { codigo: 'G19', nombre: 'General $19', precio: 1900, cantidad: 3 },
  ];
  const { piezas, total } = totales(lineas);
  assert.equal(piezas, 4);
  assert.equal(total, 30700); // $250 + 3 x $19 = $307
});

test('el cambio y lo que falta nunca son negativos a la vez', () => {
  const lineas: Linea[] = [{ codigo: 'G49', nombre: 'General $49', precio: 4900, cantidad: 1 }];
  assert.deepEqual(totales(lineas, 10000), { piezas: 1, total: 4900, cambio: 5100, falta: 0 });
  assert.deepEqual(totales(lineas, 2000), { piezas: 1, total: 4900, cambio: 0, falta: 2900 });
  assert.deepEqual(totales(lineas, 4900), { piezas: 1, total: 4900, cambio: 0, falta: 0 });
});

test('un ticket vacio no cobra nada', () => {
  assert.deepEqual(totales([]), { piezas: 0, total: 0, cambio: 0, falta: 0 });
});

test('escanear dos veces el mismo bote sube la cantidad, no agrega un renglon', () => {
  let lineas = agregar([], pieza('G19', 1900));
  lineas = agregar(lineas, pieza('G19', 1900));
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].cantidad, 2);
  assert.equal(totales(lineas).total, 3800);
});

test('dos piezas distintas son dos renglones', () => {
  let lineas = agregar([], pieza('ED-000001', 25000));
  lineas = agregar(lineas, pieza('ED-000002', 8500));
  assert.equal(lineas.length, 2);
  assert.equal(totales(lineas).total, 33500);
});

test('efectivo vacio (0) no alcanza para un total mayor a cero', () => {
  // Antes: dejar el campo en blanco enviaba efectivo=0 y la guarda no se activaba.
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 0 }), false);
});

test('efectivo exacto o de sobra si alcanza', () => {
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 4000 }), true);
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 5000 }), true);
});

test('tarjeta no se valida contra el efectivo', () => {
  assert.equal(efectivoAlcanza({ formaPago: 'tarjeta', total: 4000, efectivo: 0 }), true);
});
