import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { reiniciarPausaTarget } from './imagenes-upc.ts';
import { codigoLeido, normalizarUpc } from '../public/upc.js';

const UPC = '8438051051054', TCIN = '94882460';
const IMAGEN = 'https://target.scene7.com/is/image/Target/GUEST_ejemplo?wid=626';
const RUTA = `/api/manifiesto/${UPC}/imagen`;
const pagina = (imagen: string, codigo = UPC, status = 200) => new Response(`<html><head>
  <meta content="Yoobi &amp; pouch" property="og:title" data-next-head=""/>
  <meta content="${imagen}" property="og:image" data-next-head=""/></head>
  <body><script>{"primary_barcode":"${codigo}"}</script></body></html>`, { status });
function preparar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en)
    values (?, 'Yoobi pencil pouch', 999, ?, 'Estuche Yoobi', '')`).run(UPC, TCIN);
  t.db.prepare("insert into config (clave, valor) values ('tipo_cambio', '1850')").run();
  reiniciarPausaTarget();
  return t;
}

test('el candidato se verifica, se confirma explícitamente y se reutiliza sin HTTP ni cambiar stock', async (t) => {
  const { db, pedir } = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    llamadas++;
    assert.equal(String(url), `https://www.target.com/p/-/A-${TCIN}`);
    assert.equal(opciones.redirect, 'manual');
    // Ni sesión ni cookies del personal salen hacia Target.
    assert.deepEqual(Object.keys(opciones.headers as Record<string, string>).sort(), ['accept', 'user-agent']);
    return pagina(IMAGEN.replace('?', '?a=1&amp;'));
  });
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 409);
  const candidata = await pedir(RUTA, { url: 'http://127.0.0.1/secreto' });
  assert.equal(candidata.status, 200);
  assert.equal(candidata.cuerpo.imagen.confirmada, false);
  assert.equal(candidata.cuerpo.imagen.codigo_verificado, true);
  assert.equal(candidata.cuerpo.imagen.nombre, 'Yoobi & pouch');
  const IMAGEN_PAGINA = IMAGEN.replace('?', '?a=1&');
  assert.equal(candidata.cuerpo.imagen.url, IMAGEN_PAGINA);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA + 'otro', tcin: TCIN }, 'PUT')).status, 409);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA, tcin: TCIN }, 'PUT')).cuerpo.imagen.confirmada, true);
  assert.equal((await pedir(RUTA, {})).cuerpo.imagen.confirmada, true);
  assert.equal((await pedir(`/api/manifiesto/${UPC}`, undefined, 'GET')).cuerpo.imagen.url, IMAGEN_PAGINA);
  assert.equal(llamadas, 1);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, DUENO);
  assert.equal(db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  db.prepare("update manifiesto set tcin='123'").run();
  assert.equal((await pedir(RUTA, undefined, 'GET')).cuerpo.imagen, null);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA, tcin: TCIN }, 'PUT')).status, 409);
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

test('páginas ajenas, códigos distintos y errores no dejan imágenes', async (t) => {
  const { db, pedir } = preparar();
  const respuestas = [
    pagina(IMAGEN, '123456789012'), pagina('http://127.0.0.1/foto'), pagina('https://target.scene7.com.evil.mx/is/image/Target/x'),
    new Response('no', { status: 404 }), new Response('no', { status: 500 }), new Response(null, { status: 301 }),
    new Response('x'.repeat(3_000_001)),
  ];
  t.mock.method(globalThis, 'fetch', async () => respuestas.shift()!);
  const status = [];
  for (let i = 0; i < 7; i++) status.push((await pedir(RUTA, {})).status);
  assert.deepEqual(status, [422, 422, 422, 422, 502, 502, 502]);
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  assert.equal((await pedir('/api/manifiesto/123456789012/imagen', {})).status, 404);
});

test('la verificación «mantén presionado» de Target pausa las consultas en vez de insistir', async (t) => {
  const { db, pedir } = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    llamadas++;
    return new Response('<div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human</p>', { status: 403 });
  });
  const bloqueo = await pedir(RUTA, {});
  assert.equal(bloqueo.status, 503);
  assert.match(bloqueo.cuerpo.error, /verificación/);
  assert.equal((await pedir(RUTA, {})).status, 503);
  assert.equal(llamadas, 1);
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  reiniciarPausaTarget();
  t.mock.method(globalThis, 'fetch', async () => new Response('<div id="px-captcha"></div>'));
  assert.equal((await pedir(RUTA, {})).status, 503); // También con 200.
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
