import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { codigoLeido, normalizarUpc } from '../public/upc.js';

const UPC = '8438051051054', TCIN = '94882460';
const IMAGEN = 'https://target.scene7.com/is/image/Target/GUEST_ejemplo?wid=626';
const RUTA = `/api/manifiesto/${UPC}/imagen`;
function preparar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en)
    values (?, 'Yoobi pencil pouch', 999, ?, 'Estuche Yoobi', '')`).run(UPC, TCIN);
  t.db.prepare("insert into config (clave, valor) values ('tipo_cambio', '1850')").run();
  t.env.SCRAPLING_URL = 'https://extractor.prueba/lookup';
  t.env.SCRAPLING_TOKEN = 'token-sintetico-de-prueba';
  return t;
}

test('el candidato se verifica, se confirma explícitamente y se reutiliza sin HTTP ni cambiar stock', async (t) => {
  const { db, env, pedir } = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    llamadas++;
    assert.equal(String(url), env.SCRAPLING_URL);
    assert.equal(opciones.redirect, 'manual'); // Workers no admite redirect: 'error'; no seguir el token a otro host.
    assert.equal((opciones.headers as Record<string, string>).authorization, `Bearer ${env.SCRAPLING_TOKEN}`);
    assert.deepEqual(JSON.parse(String(opciones.body)), { url: `https://www.target.com/p/-/A-${TCIN}`, barcode: UPC });
    return Response.json({ title: 'Yoobi pouch', image_url: IMAGEN, barcode: UPC });
  });
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 409);
  const candidata = await pedir(RUTA, { url: 'http://127.0.0.1/secreto' });
  assert.equal(candidata.status, 200);
  assert.equal(candidata.cuerpo.imagen.confirmada, false);
  assert.equal(candidata.cuerpo.imagen.codigo_verificado, true);
  assert.equal((await pedir(RUTA, { url: IMAGEN + 'otro', tcin: TCIN }, 'PUT')).status, 409);
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).cuerpo.imagen.confirmada, true);
  assert.equal((await pedir(RUTA, {})).cuerpo.imagen.confirmada, true);
  assert.equal((await pedir(`/api/manifiesto/${UPC}`, undefined, 'GET')).cuerpo.imagen.url, IMAGEN);
  assert.equal(llamadas, 1);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, DUENO);
  assert.equal(db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  db.prepare("update manifiesto set tcin='123'").run();
  assert.equal((await pedir(RUTA, undefined, 'GET')).cuerpo.imagen, null);
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 409);
});

test('foto propia primero, UPC/EAN equivalentes y aislamiento de FEP/portal/vendedor', async (t) => {
  const { db, env, pedir } = preparar();
  db.prepare("update productos set upc=?, foto_key=?, stock=0 where id=?").run(UPC, `fotos/${PRODUCTO}.jpg`, PRODUCTO);
  await env.FOTOS.put(`fotos/${PRODUCTO}.jpg`, new Uint8Array([255, 216, 255]));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No debe consultar al proveedor'); });
  const propia = await pedir(RUTA, {});
  assert.equal(propia.cuerpo.imagen.origen, 'catalogo');
  assert.equal(propia.cuerpo.imagen.confirmada, true);
  const foto = await worker.fetch!(new Request(`https://caja.prueba${RUTA}/catalogo`) as never, env, { waitUntil() {} } as never);
  assert.equal(foto.status, 200);
  assert.deepEqual([...new Uint8Array(await foto.arrayBuffer())], [255, 216, 255]);
  db.prepare("update productos set propietario='fep' where id=?").run(PRODUCTO);
  assert.equal((await pedir(RUTA, undefined, 'GET')).cuerpo.imagen, null);
  db.prepare("insert into usuarios (correo,roles,creado_en,actualizado_en) values ('fep@prueba.mx','finanzas','','')").run();
  env.DEV_USUARIO = 'fep@prueba.mx';
  for (const metodo of ['GET', 'POST', 'PUT']) assert.equal((await pedir(RUTA, metodo === 'GET' ? undefined : {}, metodo)).status, 403);
  assert.equal(permitidaParaVendedor(RUTA, 'POST'), true);
  assert.equal(permitidaParaVendedor(RUTA, 'DELETE'), false);
  assert.equal(permitidaParaVendedor(`${RUTA}/catalogo`, 'GET'), true);
  assert.equal(permitidaParaVendedor(`${RUTA}/catalogo`, 'POST'), false);
  env.HOST_PORTAL = 'portal.prueba';
  const portal = await worker.fetch!(new Request(`https://portal.prueba${RUTA}`, { method: 'POST' }) as never, env, {} as never);
  assert.equal(portal.status, 404);
});

test('respuestas ajenas, códigos distintos, errores y servicio sin configurar no dejan imágenes', async (t) => {
  const { db, env, pedir } = preparar();
  const respuestas = [
    Response.json({ title: 'Otra pieza', image_url: IMAGEN, barcode: '123456789012' }),
    Response.json({ title: 'Otra pieza', image_url: 'http://127.0.0.1/foto', barcode: UPC }),
    Response.json({ title: 'Otra pieza', image_url: IMAGEN, barcode: 8438051051054 }),
    new Response('no', { status: 503 }), new Response('x'.repeat(17_000)),
  ];
  t.mock.method(globalThis, 'fetch', async () => respuestas.shift()!);
  for (let i = 0; i < 5; i++) assert.ok((await pedir(RUTA, {})).status >= 400);
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  delete env.SCRAPLING_TOKEN;
  assert.equal((await pedir(RUTA, {})).status, 503);
  assert.equal((await pedir('/api/manifiesto/123456789012/imagen', {})).status, 404);
});

test('se conserva el código original; reintentar una captura no repone lo vendido', async () => {
  const { db, pedir } = preparar();
  const leido = '0191907910414', clave = normalizarUpc(leido);
  assert.equal(codigoLeido(leido), leido);
  for (const invalido of ['UPC123456', '123-456', 191907910414, null]) assert.equal(codigoLeido(invalido), '');
  db.prepare('update manifiesto set upc=?').run(clave);
  const id = crypto.randomUUID();
  assert.equal((await pedir('/api/borradores/upc', { id, upc: leido, stock: 3 })).status, 201);
  assert.equal(db.prepare('select upc from productos where id=?').get(id)!.upc, leido);
  db.prepare('update productos set stock=1, precio=100 where id=?').run(id);
  assert.equal((await pedir('/api/borradores/upc', { id, upc: leido, stock: 3 })).cuerpo.stock, 1);
  assert.equal(db.prepare('select precio from productos where id=?').get(id)!.precio, 100);
});

test('capturas simultáneas con el mismo UUID conservan una sola pieza completa y una cantidad', async () => {
  const { db, pedir } = preparar();
  const id = crypto.randomUUID();
  const respuestas = await Promise.all([3, 9].map((stock) => pedir('/api/borradores/upc', { id, upc: UPC, stock })));
  assert.ok(respuestas.every((r) => r.status === 201));
  const guardada = db.prepare('select stock, nombre, precio, codigo, estado_analisis from productos where id=?').get(id)!;
  assert.ok([3, 9].includes(Number(guardada.stock)));
  assert.ok(respuestas.every((r) => r.cuerpo.stock === guardada.stock && r.cuerpo.precio === guardada.precio));
  assert.equal(guardada.nombre, 'Estuche Yoobi');
  assert.equal(guardada.estado_analisis, 'listo');
  assert.match(String(guardada.codigo), /^ED-\d{6}$/);
});

test('una foto de respaldo guarda el UPC, usa el manifiesto y queda disponible para otro escaneo', async () => {
  const { db, env } = preparar();
  const id = crypto.randomUUID(), cuerpo = new FormData();
  cuerpo.set('id', id); cuerpo.set('upc', UPC); cuerpo.set('cantidad', '2'); cuerpo.set('estado_fisico', 'nuevo');
  cuerpo.set('foto', new File([new Uint8Array([255, 216, 255])], 'foto.jpg', { type: 'image/jpeg' }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, env, { waitUntil() {} } as never);
  assert.equal(r.status, 201);
  const producto = db.prepare('select upc, stock, nombre, estado_analisis, foto_key from productos where id=?').get(id)!;
  assert.equal(producto.upc, UPC); assert.equal(producto.stock, 2);
  assert.equal(producto.nombre, 'Estuche Yoobi'); assert.equal(producto.estado_analisis, 'listo');
  assert.equal(producto.foto_key, `fotos/${id}.jpg`);
});

test('un producto ya identificado en el catálogo funciona aunque no esté en la hoja del proveedor', async () => {
  const { db, pedir } = preparar();
  db.prepare('delete from manifiesto').run();
  db.prepare("update productos set upc=?, foto_key=?, estado_analisis='listo' where id=?")
    .run('0191907910414', `fotos/${PRODUCTO}.jpg`, PRODUCTO);
  const ficha = await pedir('/api/manifiesto/191907910414', undefined, 'GET');
  assert.equal(ficha.status, 200);
  assert.equal(ficha.cuerpo.nombre, 'Ventilador');
  assert.equal(ficha.cuerpo.precio, 25000);
  assert.equal(ficha.cuerpo.imagen.origen, 'catalogo');
  assert.equal((await pedir('/api/manifiesto/191907910414/imagen', {})).cuerpo.imagen.origen, 'catalogo');
  const id = crypto.randomUUID();
  assert.equal((await pedir('/api/borradores/upc', { id, upc: '0191907910414', stock: 2, precio: 1 })).status, 201);
  assert.equal(db.prepare('select precio from productos where id=?').get(id)!.precio, 25000);
  assert.equal(db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
});
