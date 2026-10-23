// node --test src/cerrar-sesion.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { avisoPendientes, cerrarSesion, SALIDA } from '../public/cerrar-sesion.js';
import { permitidaParaVendedor } from './worker.ts';

test('el aviso cuenta fotos y ventas, y calla si no hay nada', () => {
  assert.equal(avisoPendientes({}), '');
  assert.match(avisoPendientes({ fotos: 1 }), /^Hay 1 foto sin subir\. Si cierras sesión, se subirán con la siguiente cuenta que entre/);
  assert.match(avisoPendientes({ fotos: 3, ventas: 2 }), /^Hay 3 fotos y 2 ventas sin subir/);
});

test('con ventas sin enviar pide confirmar; esperar no sale ni toca el turno, confirmar cierra el turno y sale', async (t) => {
  const guardado = new Map([['cajero-en-turno', JSON.stringify({ token: 'tok' })]]);
  const llamadas: [string, any][] = [];
  const original = { localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => guardado.get(k) ?? null, removeItem: (k: string) => guardado.delete(k) },
    fetch: async (url: string, init: any) => { llamadas.push([url, init]); return new Response('{}'); },
  });
  t.after(() => Object.assign(globalThis, original));
  const destinos: string[] = [], textos: string[] = [];
  const ventas = async () => 2;

  assert.equal(await cerrarSesion({ ventas, irA: (u: string) => destinos.push(u), confirmar: async (x: string) => (textos.push(x), false) }), false);
  assert.deepEqual(destinos, []);
  assert.equal(guardado.has('cajero-en-turno'), true);
  assert.match(textos[0], /2 ventas sin subir/);

  assert.equal(await cerrarSesion({ ventas, irA: (u: string) => destinos.push(u), confirmar: async () => true }), true);
  assert.deepEqual(destinos, [SALIDA]);
  assert.equal(SALIDA, '/cdn-cgi/access/logout');
  assert.equal(guardado.has('cajero-en-turno'), false);
  assert.equal(llamadas[0][0], '/api/cajeros/salir');
  assert.equal(llamadas[0][1].headers['x-cajero'], 'tok');
});

test('sin nada en cola sale directo, sin preguntar', async () => {
  const destinos: string[] = [];
  await cerrarSesion({ irA: (u: string) => destinos.push(u), confirmar: async () => { throw new Error('no debía preguntar'); } });
  assert.deepEqual(destinos, [SALIDA]);
});

test('el host del vendedor sirve el módulo que importa el menú de /inventario', () => {
  assert.equal(permitidaParaVendedor('/cerrar-sesion.js', 'GET'), true);
});
