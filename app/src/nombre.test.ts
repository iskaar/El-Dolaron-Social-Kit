import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { fichaDeManifiesto } from './manifiesto.ts';
import { analizarBorrador } from './analisis.ts';
import { identificarPieza } from './worker.ts';
import { decodificarNombre } from './nombre.ts';

const crudo = 'Chuckle &amp; Roar &quot;niños&quot; &#39;juego&#39; &lt;3&gt;';
const nombre = 'Chuckle & Roar "niños" \'juego\' <3>';

test('traducción del manifiesto guarda las cinco entidades decodificadas', async () => {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, actualizado_en) values ('123456789012', ?, 999, '')`).run(crudo);
  const ficha = await fichaDeManifiesto('123456789012', t.env, async () => ({ nombre: crudo, categoria: 'juguetes' }));
  assert.equal(ficha?.nombre, nombre);
  assert.equal(t.db.prepare('select nombre from manifiesto').get()!.nombre, nombre);
});

test('escáner decodifica nombres guardados, descripción de respaldo y captura manual al persistir', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async () => { throw new Error('sin traducción en esta prueba'); });
  for (const respaldo of [false, true]) {
    const t = tienda(), id = crypto.randomUUID();
    t.db.prepare(`insert into manifiesto (upc, descripcion, nombre, precio_usd, categoria, actualizado_en)
      values ('123456789012', ?, ?, 999, 'juguetes', '')`).run(crudo, respaldo ? '' : crudo);
    t.db.prepare("insert into config (clave, valor) values ('tipo_cambio', '1850')").run();
    assert.equal((await t.pedir('/api/borradores/upc', { id, upc: '123456789012', stock: 1 })).status, 201);
    assert.equal(t.db.prepare('select nombre from productos where id = ?').get(id)!.nombre, nombre);
  }
  const t = tienda(), id = crypto.randomUUID();
  const r = await t.pedir('/api/borradores/upc/manual', { id, upc: '', nombre: crudo, categoria: 'juguetes', precio: 19900, stock: 1 });
  assert.equal(r.status, 201); assert.equal(r.cuerpo.nombre, nombre);
  assert.equal(t.db.prepare('select nombre from productos where id = ?').get(id)!.nombre, nombre);
});

test('análisis de foto y búsqueda UPC guardan nombres decodificados, incluso sin precio', async (ctx) => {
  for (const via of ['foto', 'upc', 'upc-sin-precio']) {
    const t = tienda(), id = crypto.randomUUID();
    t.env.GEMINI_API_KEY = 'prueba';
    ctx.mock.method(globalThis, 'fetch', async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      nombre: crudo, categoria: 'juguetes', precio_lista_mxn: via === 'upc-sin-precio' ? 0 : 500, confianza: 0.9,
    }) }] } }] }));
    t.db.prepare(`insert into productos (id, upc, semana_ingreso, creado_en, actualizado_en)
      values (?, '123456789012', 'S43', '', '')`).run(id);
    if (via === 'foto') {
      await t.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
      await analizarBorrador(id, t.env, 'gemini');
    } else await identificarPieza(id, '123456789012', t.env);
    assert.equal(t.db.prepare('select nombre from productos where id = ?').get(id)!.nombre, nombre, via);
    ctx.mock.restoreAll();
  }
});

test('el helper conserva acentos, entidades desconocidas y decodifica solo una capa', () => {
  assert.equal(decodificarNombre('Dolarón &amp;lt; &otra; &'), 'Dolarón &lt; &otra; &');
});
