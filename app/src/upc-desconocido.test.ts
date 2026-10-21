// node --test src/upc-desconocido.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import worker, { permitidaParaVendedor, identificarPieza } from './worker.ts';
import { analizarBorrador } from './analisis.ts';

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
  assert.deepEqual(llamada.cuerpo.contents[0].parts, [{ text: `upc ${UPC}` }]);
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

test('el código exacto manda sobre el nombre de la foto, y una pieza ya lista no se toca (#406)', async (t) => {
  const p = preparar(t);
  p.responder({ nombre: 'Termo', marca: '', categoria: 'hogar', precio_lista_mxn: 1000, precio_venta_mxn: 0, confianza: 0.9 });
  Object.assign(p.env, { BUSQUEDAS: { send: async () => {} } });   // la búsqueda se corre a mano abajo
  const id = crypto.randomUUID(), lista = crypto.randomUUID();
  await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 1 });
  await p.pedir('/api/borradores/upc/buscar', { id: lista, upc: UPC, stock: 1 });
  p.db.prepare("update productos set foto_key = ?, nombre = 'De la foto', estado_analisis = 'error' where id = ?").run(`fotos/${id}.jpg`, id);
  p.db.prepare("update productos set nombre = 'Ya capturada', precio = 5000, estado_analisis = 'listo' where id = ?").run(lista);
  for (const pieza of [id, lista]) await identificarPieza(pieza, UPC, p.env, true);
  assert.equal(p.db.prepare('select nombre, estado_analisis from productos where id=?').get(id)!.nombre, 'Termo');
  assert.equal(p.db.prepare('select nombre from productos where id=?').get(lista)!.nombre, 'Ya capturada');
});

test('con la cola configurada, el código desconocido se encola en lugar de buscarse en waitUntil (#406)', async (t) => {
  const p = preparar(t);
  const enviados: BusquedaUpc[] = [];
  Object.assign(p.env, { BUSQUEDAS: { send: async (m: BusquedaUpc) => { enviados.push(m); } } });
  const id = crypto.randomUUID();
  assert.equal((await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 1 })).status, 202);
  await p.esperar();
  assert.deepEqual(enviados, [{ id, upc: UPC }]);
  assert.equal(p.llamadas.length, 0);
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

test('un UPC identificado sin foto se reutiliza: el siguiente escaneo no vuelve a buscarlo (#402)', async (t) => {
  const p = preparar(t);
  p.responder({ nombre: 'Termo Stanley 1 L', marca: 'Stanley', categoria: 'hogar', precio_lista_mxn: 1000, precio_venta_mxn: 0, confianza: 0.9 });
  await p.pedir('/api/borradores/upc/buscar', { id: crypto.randomUUID(), upc: UPC, stock: 1 });
  await p.esperar();
  // El lector puede mandar el mismo producto con otros ceros a la izquierda.
  const ficha = await p.pedir('/api/manifiesto/12345678905', undefined, 'GET');
  assert.equal(ficha.status, 200);
  assert.equal(ficha.cuerpo.nombre, 'Termo Stanley 1 L');
  const id = crypto.randomUUID();
  assert.equal((await p.pedir('/api/borradores/upc', { id, upc: '012345678905', stock: 3 })).status, 201);
  assert.deepEqual({ ...p.db.prepare('select nombre, precio, stock, estado_analisis from productos where id=?').get(id)! },
    { nombre: 'Termo Stanley 1 L', precio: 49900, stock: 3, estado_analisis: 'listo' });
  assert.equal(p.llamadas.length, 1);
  // FEP o una pieza sin precio no sirven de catálogo.
  p.db.prepare("update productos set propietario = 'fep' where upc = ?").run(UPC);
  assert.equal((await p.pedir('/api/manifiesto/12345678905', undefined, 'GET')).status, 200);   // queda la segunda pieza
  p.db.prepare("update productos set precio = 0 where propietario = 'dolaron' and ltrim(upc, '0') = '12345678905'").run();
  assert.equal((await p.pedir('/api/manifiesto/12345678905', undefined, 'GET')).status, 404);
});

test('Sin foto completa el mismo id desconocido y la búsqueda tardía no pisa nombre ni precio (#399)', async (t) => {
  const p = preparar(t);
  const respuesta = Promise.withResolvers<Response>();
  t.mock.method(globalThis, 'fetch', () => respuesta.promise);
  const id = crypto.randomUUID();
  await p.pedir('/api/borradores/upc/buscar', { id, upc: UPC, stock: 3 });
  const cuerpo = { id, upc: UPC, nombre: 'Termo a mano', categoria: 'hogar', precio: 12345, stock: 2 };
  const r = await p.pedir('/api/borradores/upc/manual', cuerpo);
  assert.equal(r.status, 201); assert.equal(r.cuerpo.id, id); assert.equal(r.cuerpo.upc, UPC);
  respuesta.resolve(gemini({ nombre: 'Otro de Google', marca: '', categoria: 'hogar', precio_lista_mxn: 1000, confianza: 0.9 }));
  await p.esperar();
  const fila = p.db.prepare('select nombre, precio, stock, estado_analisis, codigo from productos where id = ?').get(id)!;
  assert.equal(fila.nombre, 'Termo a mano'); assert.equal(fila.precio, 12345); assert.equal(fila.stock, 2);
  assert.equal(fila.estado_analisis, 'listo'); assert.match(String(fila.codigo), /^ED-\d{6}$/);
  assert.equal(p.db.prepare('select count(*) n from productos where upc = ?').get(UPC)!.n, 1);
  assert.equal((await p.pedir('/api/borradores/upc/manual', { ...cuerpo, upc: '99999999' })).status, 409);
  assert.equal(permitidaParaVendedor('/api/borradores/upc/manual', 'POST'), true);
  assert.equal(permitidaParaVendedor('/api/borradores/upc/manual', 'PATCH'), true);
  assert.equal(permitidaParaVendedor('/api/borradores/upc/manual', 'GET'), false);
});

test('el análisis de foto tardío, exitoso o fallido, conserva la captura sin foto (#399)', async (t) => {
  const p = preparar(t);
  for (const falla of [false, true]) {
    const id = crypto.randomUUID();
    const ahora = new Date().toISOString();
    p.db.prepare(`insert into productos (id, upc, stock, semana_ingreso, capturado_por, creado_en, actualizado_en)
      values (?, ?, 2, 'S40', 'dueno@prueba.mx', ?, ?)`).run(id, UPC, ahora, ahora);
    await p.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    const llamada = Promise.withResolvers<void>(), respuesta = Promise.withResolvers<Response>();
    t.mock.method(globalThis, 'fetch', () => { llamada.resolve(); return respuesta.promise; });
    const analisis = analizarBorrador(id, p.env, 'gemini', false);
    await llamada.promise;
    assert.equal((await p.pedir('/api/borradores/upc/manual', { id, upc: UPC, nombre: 'Nombre manual', categoria: 'hogar', precio: 9900, stock: 2 })).status, 201);
    respuesta.resolve(falla ? new Response('fallo', { status: 400 }) : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      nombre: 'De la foto', marca: '', categoria: 'otros', precio_lista_mxn: 500,
    }) }] } }] }));
    await analisis;
    const fila = p.db.prepare('select nombre, precio, estado_analisis from productos where id = ?').get(id)!;
    assert.deepEqual({ ...fila }, { nombre: 'Nombre manual', precio: 9900, estado_analisis: 'listo' });
  }
});
