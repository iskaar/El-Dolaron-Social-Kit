// node --test src/sw-caja.test.ts
// Caja sin internet (Issue #206): el service worker se sirve a la caja y solo cachea lo debido.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { tienda } from './prueba-d1.ts';

const fuente = readFileSync(new URL('../public/sw-caja.js', import.meta.url), 'utf8');
const ctx: any = { URL, self: { location: { origin: 'https://caja.prueba' }, addEventListener() {} } };
vm.runInNewContext(fuente, ctx);
const peticion = (ruta: string, metodo = 'GET', origen = 'https://caja.prueba') => ({ method: metodo, url: origen + ruta });
const ok = { type: 'basic', status: 200, redirected: false };

test('cachea GET 200 de la caja y sus scripts', () => {
  for (const r of ['/caja', '/venta.js', '/cajero.js', '/camara.js', '/impresora.js', '/ticket.js', '/code128.js'])
    assert.equal(ctx.debeCachear(peticion(r), ok), true, r);
});

test('nunca cachea la API, otros origenes, POST, redirecciones, opacas ni no-200', () => {
  assert.equal(ctx.debeCachear(peticion('/api/catalogo'), ok), false);
  assert.equal(ctx.debeCachear(peticion('/api/ventas', 'POST'), ok), false);
  assert.equal(ctx.debeCachear(peticion('/admin'), ok), false);
  assert.equal(ctx.debeCachear(peticion('/caja', 'GET', 'https://otro.mx'), ok), false);
  assert.equal(ctx.debeCachear(peticion('/caja', 'POST'), ok), false);
  assert.equal(ctx.debeCachear(peticion('/caja'), { ...ok, redirected: true }), false);
  assert.equal(ctx.debeCachear(peticion('/caja'), { ...ok, type: 'opaque' }), false);
  assert.equal(ctx.debeCachear(peticion('/caja'), { ...ok, type: 'opaqueredirect', status: 0 }), false);
  for (const status of [302, 401, 403, 404, 500]) assert.equal(ctx.debeCachear(peticion('/caja'), { ...ok, status }), false);
});

test('el worker sirve /sw-caja.js como JavaScript a la cuenta de caja', async () => {
  const { db, env, ctx: c } = tienda();
  (env as any).ASSETS = { fetch: async () => new Response(fuente, { headers: { 'content-type': 'text/javascript' } }) };
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('pc@prueba.mx', 'PC', 'computadora', 1, '', '')`).run();
  (env as any).DEV_USUARIO = 'pc@prueba.mx';
  const { default: worker } = await import('./worker.ts');
  const r = await worker.fetch!(new Request('https://caja.prueba/sw-caja.js') as never, env, c as never);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /caja-v1/);
});
