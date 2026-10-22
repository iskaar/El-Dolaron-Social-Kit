// #413: búsqueda manual y confirmación por HTTP, sin servicios reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { procesarRecortes } from './recortes.ts';

const RUTA = `/api/borradores/${PRODUCTO}/imagen`;
const UPC = '0012345678905';
const IMAGEN = 'https://marca.prueba/linterna.png';
const bytes = new Uint8Array([1, 2, 3]);
const foto = () => new Response(bytes, { headers: { 'content-type': 'image/png' } });
const grounding = (paginas: string[]) => Response.json({ candidates: [{
  content: { parts: [{ text: `No es JSON: usa https://modelo.prueba/inventada.jpg` }] },
  groundingMetadata: { groundingChunks: paginas.map((uri) => ({ web: { uri, title: 'Título inventado' } })) },
}] });
function preparar() {
  const p = tienda();
  p.env.VERTEX_API_KEY = 'vertex-sintetica';
  p.db.prepare("update productos set nombre='Flapper Lantern', marca='BARK', upc=?, estado_analisis='listo', destino='etiqueta' where id=?").run(UPC, PRODUCTO);
  return p;
}

test('candidatas de og:image y Product del grounding, redirección Vertex, máximo tres; nunca del texto del modelo', async (t) => {
  const p = preparar();
  let vertex = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://aiplatform.googleapis.com/')) {
      vertex++;
      const cuerpo = JSON.parse(String(opciones.body));
      assert.deepEqual(cuerpo.tools, [{ googleSearch: {} }]);
      assert.deepEqual(cuerpo.contents[0].parts, [{ text: `BARK Flapper Lantern ${UPC}` }]);
      assert.equal(cuerpo.generationConfig.responseSchema, undefined);
      return grounding(['https://vertexaisearch.cloud.google.com/grounding-api-redirect/1', 'https://tienda.prueba/producto', 'https://tercera.prueba/p', 'https://cuarta.prueba/p']);
    }
    assert.equal(opciones.redirect, 'manual');
    assert.deepEqual(Object.keys(opciones.headers as object).sort(), ['accept', 'user-agent']);
    if (u.includes('vertexaisearch')) return new Response(null, { status: 302, headers: { location: 'https://marca.prueba/p' } });
    if (u === 'https://marca.prueba/p') return new Response(`<META CONTENT='/linterna.png?a=1&amp;b=2' PROPERTY='og:image'><meta content='Linterna &quot;BARK&quot;' property='og:title'>`);
    if (u === 'https://tienda.prueba/producto') return new Response(`<script type="application/ld+json">{"@graph":[{"@type":["Product"],"name":"Producto real","image":[{"url":"/foto.jpg"}]}]}</script>`);
    if (u === 'https://tercera.prueba/p' || u === 'https://cuarta.prueba/p') return new Response(`<title>Otra tienda</title><meta property="og:image" content="/foto.jpg">`);
    assert.fail(`URL ajena al grounding: ${u}`);
  });
  const r = await p.pedir(`${RUTA}/buscar`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo.candidatas, [
    { imagen: IMAGEN + '?a=1&b=2', pagina: 'https://marca.prueba/p', titulo: 'Linterna "BARK"', sitio: 'marca.prueba' },
    { imagen: 'https://tienda.prueba/foto.jpg', pagina: 'https://tienda.prueba/producto', titulo: 'Producto real', sitio: 'tienda.prueba' },
    { imagen: 'https://tercera.prueba/foto.jpg', pagina: 'https://tercera.prueba/p', titulo: 'Otra tienda', sitio: 'tercera.prueba' },
  ]);
  assert.equal(vertex, 1);
  assert.equal(p.db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  assert.equal(p.db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, '');
  assert.equal(await p.env.FOTOS.get(`fotos/${PRODUCTO}.jpg`), null);
});

test('sin grounding no usa URLs del modelo; sin Vertex da 503 aunque haya llave de AI Studio', async (t) => {
  const p = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => { llamadas++; return grounding([]); });
  assert.deepEqual((await p.pedir(`${RUTA}/buscar`, {})).cuerpo.candidatas, []);
  delete p.env.VERTEX_API_KEY;
  p.env.GEMINI_API_KEY = 'no-usar';
  const r = await p.pedir(`${RUTA}/buscar`, {});
  assert.equal(r.status, 503); assert.match(r.cuerpo.error, /VERTEX_API_KEY/);
  assert.equal(llamadas, 1);
});

test('páginas sin imagen, bloqueadas, repetidas o inseguras se omiten; error Vertex no se reintenta', async (t) => {
  const p = preparar();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).includes('aiplatform.googleapis.com')) return grounding(['http://insegura.prueba/p', 'https://tienda.prueba/p', 'https://tienda.prueba/p', 'https://bloqueada.prueba/p']);
    if (String(url).includes('bloqueada')) return new Response('reto', { status: 403 });
    assert.equal(String(url), 'https://tienda.prueba/p');
    return new Response('<meta property="og:image" content="http://foto.prueba/x">');
  });
  assert.deepEqual((await p.pedir(`${RUTA}/buscar`, {})).cuerpo.candidatas, []);
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => { llamadas++; return new Response('sin cuota', { status: 429 }); });
  assert.equal((await p.pedir(`${RUTA}/buscar`, {})).status, 502);
  assert.equal(llamadas, 1);
});

test('Usar esta guarda con content-type, conserva la pieza y habilita catálogo, ML, reutilización del UPC y sin quitar fondo (#423)', async (t) => {
  const p = preparar();
  const antes = p.db.prepare('select nombre, marca, precio, stock, estado_analisis, estado_fisico, codigo from productos where id=?').get(PRODUCTO);
  t.mock.method(globalThis, 'fetch', async (url: string) => { assert.equal(String(url), IMAGEN); return foto(); });
  // Confirmar no requiere volver a consultar Vertex.
  delete p.env.VERTEX_API_KEY;
  const r = await p.pedir(RUTA, { imagen: IMAGEN, nombre: 'No cambiar', stock: 1 }, 'PUT');
  assert.equal(r.status, 200);
  const fotoKey = `fotos/${PRODUCTO}.jpg`;
  assert.equal(p.db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, fotoKey);
  assert.deepEqual(p.db.prepare('select nombre, marca, precio, stock, estado_analisis, estado_fisico, codigo from productos where id=?').get(PRODUCTO), antes);
  const guardada = (await p.env.FOTOS.get(fotoKey))!;
  assert.equal(guardada.httpMetadata?.contentType, 'image/png');
  assert.deepEqual(new Uint8Array(await guardada.arrayBuffer()), bytes);
  assert.equal((await p.pedir('/api/manifiesto/12345678905/imagen', undefined, 'GET')).cuerpo.imagen.origen, 'catalogo');
  const ml = await p.pedir('/api/ml/piezas', undefined, 'GET');
  assert.equal(ml.status, 200); assert.ok(JSON.stringify(ml.cuerpo).includes(PRODUCTO));
  p.env.HOST_PORTAL = 'portal.prueba';
  const publica = await worker.fetch!(new Request('https://portal.prueba/api/catalogo/foto/ED-000001') as never, p.env, p.ctx as never);
  assert.equal(publica.status, 200); assert.deepEqual(new Uint8Array(await publica.arrayBuffer()), bytes);
  p.db.prepare("insert into config (clave,valor) values ('recortes_activo','1')").run();
  let recortes = 0;
  p.env.IMAGES = { input() { recortes++; return { transform() { return { output: async () => foto() }; } }; } } as never;
  await procesarRecortes(p.env); assert.equal(recortes, 0);
  assert.equal(p.db.prepare("select recorte_estado from productos where codigo='ED-000001'").get()?.recorte_estado, 'original');
});

test('foto ya puesta → 409; FEP, vendedor, portal y cajero quedan fuera; capturista sí puede', async (t) => {
  const p = preparar();
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Sin llamadas externas'); });
  p.db.prepare("update productos set foto_key='propia' where id=?").run(PRODUCTO);
  for (const [ruta, metodo] of [[`${RUTA}/buscar`, 'POST'], [RUTA, 'PUT']]) {
    assert.equal((await p.pedir(ruta, { imagen: IMAGEN }, metodo)).status, 409);
    assert.equal(permitidaParaVendedor(ruta, metodo), false);
  }
  p.db.prepare("update productos set foto_key='', propietario='fep' where id=?").run(PRODUCTO);
  assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 404);
  p.db.prepare("update productos set propietario='dolaron' where id=?").run(PRODUCTO);
  for (const rol of ['finanzas', 'cajero']) {
    p.db.prepare("insert into usuarios(correo,roles,creado_en,actualizado_en) values (?,?, '', '')").run(`${rol}@prueba.mx`, rol);
    p.env.DEV_USUARIO = `${rol}@prueba.mx`;
    assert.equal((await p.pedir(`${RUTA}/buscar`, {})).status, 403);
    assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 403);
  }
  p.env.DEV_USUARIO = DUENO;
  for (const host of ['HOST_PORTAL', 'HOST_VENDEDOR'] as const) {
    p.env[host] = 'caja.prueba';
    assert.equal((await p.pedir(`${RUTA}/buscar`, {})).status, 404);
    assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 404);
    delete p.env[host];
  }
  p.db.prepare("insert into usuarios(correo,roles,creado_en,actualizado_en) values ('cap@prueba.mx','capturista','','')").run();
  p.env.DEV_USUARIO = 'cap@prueba.mx';
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).includes('aiplatform') ? grounding([]) : foto());
  assert.equal((await p.pedir(`${RUTA}/buscar`, {})).status, 200);
  assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 200);
});

test('URL elegida: HTTPS sin credenciales ni puerto; cuerpo inválido no descarga', async (t) => {
  const p = preparar();
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('No debe descargar'); });
  for (const imagen of [null, 7, '', 'http://foto.prueba/x', 'https://u:p@foto.prueba/x', 'https://foto.prueba:444/x', 'https://foto.prueba:443/x', 'data:image/png;base64,abc', 'https://foto.prueba/' + 'a'.repeat(2001)]) {
    assert.equal((await p.pedir(RUTA, { imagen }, 'PUT')).status, 400, String(imagen));
  }
  assert.equal((await p.pedir(RUTA, null, 'PUT')).status, 400);
  assert.equal((await p.pedir('/api/borradores/no-es-uuid/imagen', { imagen: IMAGEN }, 'PUT')).status, 400);
  assert.equal((await p.pedir(`/api/borradores/${crypto.randomUUID()}/imagen`, { imagen: IMAGEN }, 'PUT')).status, 404);
});

test('descarga: redirecciones manuales, hasta tres HTTPS y un solo plazo de 10 s', async (t) => {
  const p = preparar();
  let llamadas = 0, signal: AbortSignal | null | undefined;
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 10_000); return timeout(ms); });
  t.mock.method(globalThis, 'fetch', async (_url: string, opciones: RequestInit) => {
    assert.equal(opciones.redirect, 'manual');
    if (signal) assert.equal(opciones.signal, signal); else signal = opciones.signal;
    llamadas++;
    return llamadas <= 3 ? new Response(null, { status: 302, headers: { location: `/foto${llamadas}` } }) : foto();
  });
  assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 200);
  assert.equal(llamadas, 4);
});

test('redirección insegura, exceso de saltos/bytes, tipo incorrecto y timeout no guardan foto', async (t) => {
  for (const responder of [
    () => new Response(null, { status: 302, headers: { location: 'http://otra.prueba/foto' } }),
    () => new Response(null, { status: 307, headers: { location: 'https://u:p@otra.prueba/foto' } }),
    () => new Response(null, { status: 308, headers: { location: 'https://otra.prueba:444/foto' } }),
    () => new Response(null, { status: 302, headers: { location: '//otra.prueba:443/foto' } }),
    () => new Response(null, { status: 302, headers: { location: '/bucle' } }),
    () => new Response('no', { status: 500 }),
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(6 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    () => new Response(null, { headers: { 'content-type': 'image/png' } }),
    () => { throw new DOMException('Timeout', 'TimeoutError'); },
  ]) {
    const p = preparar(); let llamadas = 0;
    t.mock.method(globalThis, 'fetch', async () => { llamadas++; return responder(); });
    assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 502);
    assert.ok(llamadas <= 4);
    assert.equal(await p.env.FOTOS.get(`fotos/${PRODUCTO}.jpg`), null);
    assert.equal(p.db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, '');
  }
});

test('foto propia en vuelo o cambio de alcance no se pisan; el UPDATE comprueba foto_key vacío', { timeout: 5000 }, async (t) => {
  for (const cambio of ['r2', 'foto', 'fep', 'descartado', 'durante-put']) {
    const p = preparar();
    const iniciada = Promise.withResolvers<void>(), respuesta = Promise.withResolvers<Response>();
    t.mock.method(globalThis, 'fetch', () => { iniciada.resolve(); return respuesta.promise; });
    const pendiente = p.pedir(RUTA, { imagen: IMAGEN }, 'PUT');
    await iniciada.promise;
    const fotoKey = `fotos/${PRODUCTO}.jpg`;
    if (cambio === 'r2' || cambio === 'foto') await p.env.FOTOS.put(fotoKey, new Uint8Array([9]));
    if (cambio === 'foto') p.db.prepare('update productos set foto_key=? where id=?').run(fotoKey, PRODUCTO);
    if (cambio === 'fep') p.db.prepare("update productos set propietario='fep' where id=?").run(PRODUCTO);
    if (cambio === 'descartado') p.db.prepare("update productos set estado_analisis='descartado' where id=?").run(PRODUCTO);
    if (cambio === 'durante-put') {
      const put = p.env.FOTOS.put.bind(p.env.FOTOS);
      t.mock.method(p.env.FOTOS, 'put', async (key: string, valor: BodyInit, opciones: R2PutOptions) => {
        const r = await put(key, valor as never, opciones);
        await put(key, new Uint8Array([9]));
        p.db.prepare('update productos set foto_key=? where id=?').run(fotoKey, PRODUCTO);
        return r;
      });
    }
    respuesta.resolve(foto());
    assert.equal((await pendiente).status, 409, cambio);
    if (['r2', 'foto', 'durante-put'].includes(cambio)) assert.deepEqual(new Uint8Array(await (await p.env.FOTOS.get(fotoKey))!.arrayBuffer()), new Uint8Array([9]));
    if (['r2', 'fep', 'descartado'].includes(cambio)) assert.equal(p.db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, '');
  }
});

test('la cola y la revisión de /admin exponen foto_key y propietario para mostrar el botón solo sin foto', async () => {
  const p = preparar();
  const cola = await p.pedir('/api/borradores', undefined, 'GET');
  const pieza = (cola.cuerpo as any).find((p: any) => p.id === PRODUCTO);
  assert.equal(pieza.foto_key, ''); assert.equal(pieza.propietario, 'dolaron');
  const revision = await p.pedir('/api/catalogo/revision', undefined, 'GET');
  assert.equal(revision.cuerpo.piezas[0].foto_key, '');
  assert.equal(revision.cuerpo.piezas[0].propietario, 'dolaron');
});

test('un fallo de D1 después del put se recupera con la misma URL sin sobrescribir R2', async (t) => {
  const p = preparar();
  t.mock.method(globalThis, 'fetch', async () => foto());
  p.db.exec("create trigger fallo_foto before update of foto_key on productos begin select raise(abort, 'fallo simulado'); end");
  assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 502);
  const guardada = await p.env.FOTOS.get(`fotos/${PRODUCTO}.jpg`);
  assert.ok(guardada);
  p.db.exec('drop trigger fallo_foto');
  assert.equal((await p.pedir(RUTA, { imagen: IMAGEN }, 'PUT')).status, 200);
  assert.equal((await p.env.FOTOS.get(`fotos/${PRODUCTO}.jpg`))!.etag, guardada.etag);
});

// DOM mínimo para ejercitar los clics reales del helper de /admin sin dependencias.
class Elemento {
  hijos: Elemento[] = [];
  eventos: Record<string, () => Promise<void>> = {};
  disabled = false;
  eliminado = false;
  textContent = '';
  src = '';
  style = { color: '' };
  tipo: string;
  constructor(tipo = 'div') { this.tipo = tipo; }
  append(...hijos: Elemento[]) { this.hijos.push(...hijos); }
  replaceChildren(...hijos: Elemento[]) { this.hijos = hijos; }
  addEventListener(tipo: string, fn: () => Promise<void>) { this.eventos[tipo] = fn; }
  querySelectorAll(tipo: string): Elemento[] { return this.hijos.flatMap((h) => [...(h.tipo === tipo ? [h] : []), ...h.querySelectorAll(tipo)]); }
  remove() { this.eliminado = true; }
}
const admin = readFileSync('public/admin.html', 'utf8');
const helper = admin.slice(admin.indexOf('async function buscarImagen('), admin.indexOf('/* ---------- revisión del catálogo'));

test('/admin busca solo al clic, muestra la fuente como texto y Usar esta envía solo la URL', async () => {
  const lista = new Elemento(), aviso = new Elemento(), boton = new Elemento('button'), principal = new Elemento('img');
  const p = { id: PRODUCTO, foto_key: '' };
  const llamadas: { ruta: string; opciones: RequestInit }[] = [];
  const buscar = runInNewContext(`${helper}; buscarImagen`, {
    document: { createElement: (tipo: string) => new Elemento(tipo) }, Date,
    fetch: async (ruta: string, opciones: RequestInit) => {
      llamadas.push({ ruta, opciones });
      return opciones.method === 'POST' ? Response.json({ candidatas: [{ imagen: IMAGEN, pagina: 'https://marca.prueba/p', titulo: '<img onerror=alert(1)>', sitio: 'marca.prueba' }] })
        : Response.json({ foto_key: `fotos/${PRODUCTO}.jpg` });
    },
  });
  assert.equal(llamadas.length, 0);
  const nodo = { querySelector: (selector: string) => selector === '.candidatas' ? lista : principal };
  await buscar(p, nodo, aviso, boton);
  assert.equal(llamadas.length, 1); assert.equal(llamadas[0].ruta, `${RUTA}/buscar`);
  const enlace = lista.querySelectorAll('a')[0] as Elemento & { href: string; rel: string };
  assert.equal(enlace.href, 'https://marca.prueba/p');
  assert.equal(enlace.textContent, '<img onerror=alert(1)> · marca.prueba');
  assert.match(enlace.rel, /noreferrer/);
  await lista.querySelectorAll('button')[0].eventos.click();
  assert.equal(llamadas.length, 2); assert.equal(llamadas[1].ruta, RUTA);
  assert.deepEqual(JSON.parse(String(llamadas[1].opciones.body)), { imagen: IMAGEN });
  assert.equal(p.foto_key, `fotos/${PRODUCTO}.jpg`);
  assert.equal(boton.eliminado, true); assert.equal(lista.hijos.length, 0);
  assert.match(principal.src, /\/api\/foto\//);
});

test('/admin muestra 409 al confirmar y permite reintentar tras un error de red', async () => {
  const lista = new Elemento(), aviso = new Elemento(), boton = new Elemento('button');
  const p = { id: PRODUCTO, foto_key: '' };
  let llamadas = 0;
  const buscar = runInNewContext(`${helper}; buscarImagen`, {
    document: { createElement: (tipo: string) => new Elemento(tipo) },
    fetch: async (_ruta: string, opciones: RequestInit) => {
      if (++llamadas === 1) throw new TypeError('sin conexión');
      return opciones.method === 'POST' ? Response.json({ candidatas: [{ imagen: IMAGEN, pagina: 'https://marca.prueba/p', titulo: 'Linterna', sitio: 'marca.prueba' }] })
        : Response.json({ error: 'La pieza ya tiene foto.' }, { status: 409 });
    },
  });
  const nodo = { querySelector: () => lista };
  await buscar(p, nodo, aviso, boton);
  assert.match(aviso.textContent, /No se pudo buscar/); assert.equal(boton.disabled, false);
  await buscar(p, nodo, aviso, boton);
  const usar = lista.querySelectorAll('button')[0];
  await usar.eventos.click();
  assert.equal(aviso.textContent, 'La pieza ya tiene foto.');
  assert.equal(p.foto_key, ''); assert.equal(usar.disabled, false);
});
