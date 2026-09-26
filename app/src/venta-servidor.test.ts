// node --test src/venta-servidor.test.ts
// El servidor nunca confia en lo que manda la caja para precio, nombre o codigo:
// esos salen del catalogo. Aqui se prueba esa regla sin tocar D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararLineas } from './worker.ts';

const catalogo = () => new Map([
  ['a1111111-1111-4111-8111-111111111111',
    { id: 'a1111111-1111-4111-8111-111111111111', codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, sin_inventario: 0 }],
  ['00000000-0000-4000-8000-200000000019',
    { id: '00000000-0000-4000-8000-200000000019', codigo: 'G19', nombre: 'General $19', precio: 1900, sin_inventario: 1 }],
]);

test('un precio alterado por el navegador se ignora: manda el del catalogo', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'a1111111-1111-4111-8111-111111111111', precio: 1, cantidad: 1 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].precio, 25000);
});

test('producto inexistente: 4xx logico, no hay linea que registrar', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'no-existe', cantidad: 1 }],
    catalogo(),
  );
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /inexistente/);
});

test('cantidad invalida: cero, negativa o no entera se rechaza', () => {
  for (const cantidad of [0, -1, 1.5, NaN]) {
    const resultado = prepararLineas(
      [{ producto_id: 'a1111111-1111-4111-8111-111111111111', cantidad }],
      catalogo(),
    );
    assert.equal(resultado.ok, false, `cantidad ${cantidad} deberia rechazarse`);
  }
});

test('un ticket vacio no produce lineas', () => {
  const resultado = prepararLineas([], catalogo());
  assert.equal(resultado.ok, false);
});

test('la banda se marca sin inventario: la caja no le descuenta existencia', () => {
  const resultado = prepararLineas(
    [{ producto_id: '00000000-0000-4000-8000-200000000019', cantidad: 3 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].sinInventario, true);
  assert.equal(resultado.lineas[0].precio, 1900);
});

test('la puerta del vendedor deja corregir la existencia, y nada mas de una pieza', async () => {
  const { permitidaParaVendedor } = await import('./worker.ts');
  const id = 'a1111111-1111-4111-8111-111111111111';
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'PATCH'), true);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'GET'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'PATCH'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'DELETE'), false);
  assert.equal(permitidaParaVendedor('/api/borradores', 'GET'), false);
  assert.equal(permitidaParaVendedor('/api/borradores', 'POST'), true);
});
