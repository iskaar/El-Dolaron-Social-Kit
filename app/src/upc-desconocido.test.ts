// node --test src/upc-desconocido.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';

const UPC = '0012345678905';
const gemini = (ficha: Record<string, unknown>) => new Response(JSON.stringify({ candidates: [{
  content: { parts: [{ text: '```json\n' + JSON.stringify(ficha) + '\n```' }] },
  groundingMetadata: { groundingChunks: [{ web: { title: 'walmart.com.mx' } }] },
}] }));

function preparar(t: any) {
  const tt = tienda();
  (tt.env as any).VERTEX_API_KEY = 'llave-vertex';
  tt.db.prepare("insert or replace into config (clave, valor) values ('pct_otros', '50'), ('pct_hogar', '50'), ('pct_danado', '60')").run();
  const llamadas: any[] = [];
  return { ...tt, llamadas, responder(ficha: Record<string, unknown>) {
    t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
      llamadas.push({ url: String(url), cuerpo: JSON.parse(String(opciones.body)) });
      return gemini(ficha);
    });
  } };
}

test('un UPC desconocido se guarda al instante y se identifica solo por el código, sin foto (#373)', async (t) => {
  const p = preparar(t);
  p.responder({ nombre: 'Termo Stanley 1 L', marca: 'Stanley', categoria: 'hogar', precio_lista_mxn: 1000, precio_venta_mxn: 0, confianza: 0.9 });
  const id = crypto.randomUUID();
  const r = await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 2, estado_fisico: 'danado' });
  assert.equal(r.status, 202);
  assert.equal(r.cuerpo.estado_analisis, 'pendiente');
  assert.equal(r.cuerpo.upc, UPC);
  await p.esperar();
  const [llamada] = p.llamadas;
  assert.match(llamada.url, /aiplatform\.googleapis\.com/);
  assert.deepEqual(llamada.cuerpo.tools, [{ googleSearch: {} }]);
  assert.deepEqual(llamada.cuerpo.contents[0].parts, [{ text: `Codigo de barras: ${UPC}` }]);
  const fila = p.db.prepare('select nombre, precio_lista, precio, stock, estado_analisis, codigo, estado_fisico from productos where id=?').get(id)!;
  // $1000 x 50 % x 60 % (dañado) = $300 -> $299, con código para imprimir.
  assert.deepEqual({ ...fila }, { nombre: 'Termo Stanley 1 L', precio_lista: 100000, precio: 29900, stock: 2, estado_analisis: 'listo',
    codigo: fila.codigo, estado_fisico: 'danado' });
  assert.match(String(fila.codigo), /^ED-\d{6}$/);
  assert.equal((await p.pedir(`/api/borradores/upc/${id}`, undefined, 'GET')).cuerpo.estado_analisis, 'listo');
  // Reintentar el mismo id no vuelve a buscar ni cambia la cantidad.
  assert.equal((await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 9 })).cuerpo.stock, 2);
  await p.esperar();
  assert.equal(p.llamadas.length, 1);
});

test('sin resultado seguro queda en error para foto; la foto de esa pieza no la duplica ni repone stock', async (t) => {
  const p = preparar(t);
  p.responder({ nombre: 'Algo', marca: '', categoria: 'otros', precio_lista_mxn: 500, precio_venta_mxn: 0, confianza: 0.2 });
  const id = crypto.randomUUID();
  await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 3 });
  await p.esperar();
  const fila = p.db.prepare('select nombre, precio, estado_analisis, codigo from productos where id=?').get(id)!;
  assert.deepEqual({ ...fila }, { nombre: '', precio: 0, estado_analisis: 'error', codigo: null });
  p.db.prepare('update productos set stock = 1 where id = ?').run(id);   // la caja vendió dos
  const cuerpo = new FormData();
  cuerpo.set('id', id); cuerpo.set('upc', UPC); cuerpo.set('cantidad', '3'); cuerpo.set('estado_fisico', 'nuevo');
  cuerpo.set('foto', new File([new Uint8Array([255, 216, 255])], 'foto.jpg', { type: 'image/jpeg' }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, p.env, p.ctx as never);
  assert.equal(r.status, 201);
  const despues = p.db.prepare('select count(*) n, max(stock) stock, max(estado_analisis) estado, max(foto_key) foto from productos where upc=?').get(UPC)!;
  assert.equal(despues.n, 1);
  assert.equal(despues.stock, 1);
  assert.equal(despues.foto, `fotos/${id}.jpg`);
});

test('una foto que llega mientras se busca manda: la respuesta tardía de Gemini no la pisa', async (t) => {
  const p = preparar(t);
  p.responder({ nombre: 'Termo', marca: '', categoria: 'hogar', precio_lista_mxn: 1000, precio_venta_mxn: 0, confianza: 0.9 });
  const id = crypto.randomUUID();
  await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 1 });
  p.db.prepare("update productos set foto_key = ?, nombre = 'De la foto' where id = ?").run(`fotos/${id}.jpg`, id);
  await p.esperar();
  assert.equal(p.db.prepare('select nombre from productos where id=?').get(id)!.nombre, 'De la foto');
});

test('lo que sí está en la hoja, datos inválidos y permisos', async (t) => {
  const p = preparar(t);
  p.responder({});
  p.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en) values ('12345678905', 'x', 999, '1', 'x', '')`).run();
  assert.equal((await p.pedir('/api/borradores/upc/buscar', { id: crypto.randomUUID(), upc: UPC, stock: 1 })).status, 409);
  for (const malo of [{ id: 'x', upc: '99999999', stock: 1 }, { id: crypto.randomUUID(), upc: 'abc', stock: 1 },
    { id: crypto.randomUUID(), upc: '99999999', stock: 0 }, { id: crypto.randomUUID(), upc: '99999999', stock: 1, estado_fisico: 'roto' }]) {
    assert.equal((await p.pedir('/api/borradores/upc/buscar', malo)).status, 400, JSON.stringify(malo));
  }
  assert.equal((await p.pedir(`/api/borradores/upc/${crypto.randomUUID()}`, undefined, 'GET')).status, 404);
  assert.equal(permitidaParaVendedor('/api/borradores/upc/buscar', 'POST'), true);
  assert.equal(permitidaParaVendedor('/api/borradores/upc/buscar', 'GET'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/upc/${crypto.randomUUID()}`, 'GET'), true);
  assert.equal(permitidaParaVendedor(`/api/borradores/upc/${crypto.randomUUID()}`, 'POST'), false);
  assert.equal(p.llamadas.length, 0);
});
