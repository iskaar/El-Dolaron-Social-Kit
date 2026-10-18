// node --test src/errores.test.ts: el error de la caja llega al log con su pila (Issue #281).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

test('error del navegador llega al log con su pila (Issue #281)', async () => {
  const t = tienda();
  const original = console.error;
  const lineas: string[] = [];
  console.error = (...args: unknown[]) => { lineas.push(String(args[0])); };
  try {
    const r = await t.pedir('/api/errores', { origen:'excepcion', pantalla:'/caja', error:'boom', pila:'Error: boom\n at caja' });
    assert.equal(r.status, 204);
    const log = JSON.parse(lineas.at(-1)!);
    assert.equal(log.mensaje, 'error en el navegador');
    assert.equal(log.pantalla, '/caja');
    assert.equal(log.pila, 'Error: boom\n at caja');
  } finally {
    console.error = original;
    t.db.close();
  }
});
