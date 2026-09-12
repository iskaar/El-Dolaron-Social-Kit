// node --test src/venta.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { totales, agregar } from '../public/venta.js';

interface Linea { codigo: string; nombre: string; precio: number; cantidad: number }
const pieza = (codigo: string, precio: number) => ({ codigo, nombre: codigo, precio });

test('el total suma precio por cantidad', () => {
  const lineas: Linea[] = [
    { codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 },
    { codigo: 'BIN-20', nombre: 'Bin $20', precio: 2000, cantidad: 3 },
  ];
  const { piezas, total } = totales(lineas);
  assert.equal(piezas, 4);
  assert.equal(total, 31000); // $250 + 3 x $20 = $310
});

test('el cambio y lo que falta nunca son negativos a la vez', () => {
  const lineas: Linea[] = [{ codigo: 'BIN-40', nombre: 'Bin $40', precio: 4000, cantidad: 1 }];
  assert.deepEqual(totales(lineas, 10000), { piezas: 1, total: 4000, cambio: 6000, falta: 0 });
  assert.deepEqual(totales(lineas, 2000), { piezas: 1, total: 4000, cambio: 0, falta: 2000 });
  assert.deepEqual(totales(lineas, 4000), { piezas: 1, total: 4000, cambio: 0, falta: 0 });
});

test('un ticket vacio no cobra nada', () => {
  assert.deepEqual(totales([]), { piezas: 0, total: 0, cambio: 0, falta: 0 });
});

test('escanear dos veces el mismo bote sube la cantidad, no agrega un renglon', () => {
  let lineas = agregar([], pieza('BIN-20', 2000));
  lineas = agregar(lineas, pieza('BIN-20', 2000));
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].cantidad, 2);
  assert.equal(totales(lineas).total, 4000);
});

test('dos piezas distintas son dos renglones', () => {
  let lineas = agregar([], pieza('ED-000001', 25000));
  lineas = agregar(lineas, pieza('ED-000002', 8500));
  assert.equal(lineas.length, 2);
  assert.equal(totales(lineas).total, 33500);
});
