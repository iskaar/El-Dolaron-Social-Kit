// node --test src/inventario-precio.test.ts
// #451: reglas de la solicitud de precio que el navegador aplica antes de molestar al servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validarPedido, motivoCambio, cambioGrande, porcentaje, cuando, quien, puedePedirPrecio, MAXIMO } from '../public/inventario-precio.js';

const pieza = { precio: 25000, precio_lista: 40000 };

test('el pedido exige sentido y un sugerido que vaya en esa dirección, sin pasar de la lista', () => {
  assert.ok(validarPedido('', '', pieza).error);
  assert.deepEqual(validarPedido('bajar', '', pieza).cuerpo, { sentido: 'bajar' });
  assert.deepEqual(validarPedido('bajar', ' 200,50 ', pieza).cuerpo, { sentido: 'bajar', precio_sugerido: 20050 });
  assert.deepEqual(validarPedido('subir', '300', pieza).cuerpo, { sentido: 'subir', precio_sugerido: 30000 });
  for (const [sentido, texto] of [['subir', '250'], ['subir', '200'], ['subir', '401'], ['bajar', '250'], ['bajar', '300'], ['bajar', '0'],
    ['bajar', 'abc'], ['bajar', '1.999'], ['subir', '-5'], ['subir', '1000000']])
    assert.ok(validarPedido(sentido, texto, pieza).error, `${sentido} ${texto}`);
  assert.equal(validarPedido('subir', '5000', { precio: 100, precio_lista: 0 }).cuerpo?.precio_sugerido, 500000, 'sin lista no hay tope de lista');
  assert.ok(validarPedido('subir', '100001', { precio: 100, precio_lista: 0 }).error, 'tope de $100,000');
  assert.equal(MAXIMO, 10_000_000);
});

test('el dueño no puede cambiar a un precio inválido, igual o por encima de la lista', () => {
  const s = { precio: 25000, precio_lista: 40000 };
  assert.equal(motivoCambio('300', s), '');
  assert.equal(motivoCambio('400', s), '');
  for (const texto of ['', 'x', '0', '-1', '250', '250.00', '400.01', '100001'])
    assert.notEqual(motivoCambio(texto, s), '', texto);
  assert.equal(motivoCambio('9999', { precio: 100, precio_lista: 0 }), '');
});

test('más de la mitad del precio es un cambio grande que pide confirmar', () => {
  assert.equal(cambioGrande(25000, 37500), false);
  assert.equal(cambioGrande(25000, 37501), true);
  assert.equal(cambioGrande(25000, 12500), false);
  assert.equal(cambioGrande(25000, 12499), true);
  assert.equal(porcentaje(25000, 20000), -20);
  assert.equal(porcentaje(25000, 40000), 60);
});

test('la hora se dice en la hora de la tienda, no del navegador', () => {
  const ahora = new Date('2026-10-22T20:00:00Z');   // 14:00 en la tienda
  assert.equal(cuando('2026-10-22T17:02:00Z', ahora), 'hoy 11:02');
  assert.equal(cuando('2026-10-22T05:30:00Z', ahora), 'ayer 23:30', '23:30 del 21 en la tienda');
  assert.equal(cuando('2026-10-21T17:05:00Z', ahora), 'ayer 11:05');
  assert.match(cuando('2026-10-18T17:05:00Z', ahora), /^18 oct 11:05$/);
  assert.equal(cuando('basura', ahora), '');
  assert.equal(quien('ana.lopez@gmail.com'), 'ana.lopez');
});

test('el botón es de capturistas sobre piezas de etiqueta ya listas; el dueño edita directo', () => {
  const p = { destino: 'etiqueta', estado_analisis: 'listo', precio: 25000 };
  const como = (roles: string[]) => ({ usuario: { roles } });
  assert.equal(puedePedirPrecio(como(['capturista']), p), true);
  assert.equal(puedePedirPrecio(como(['dueno']), p), false);
  assert.equal(puedePedirPrecio(como(['capturista', 'dueno']), p), false);
  assert.equal(puedePedirPrecio(como(['cajero']), p), false);
  assert.equal(puedePedirPrecio(como(['finanzas']), p), false);
  assert.equal(puedePedirPrecio({}, p), false);
  assert.equal(puedePedirPrecio(como(['capturista']), { ...p, destino: 'banda_g49' }), false);
  assert.equal(puedePedirPrecio(como(['capturista']), { ...p, estado_analisis: 'pendiente' }), false);
  assert.equal(puedePedirPrecio(como(['capturista']), { ...p, precio: 0 }), false);
});
