import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { reiniciarPausaTarget, pausarUpcitemdbPor } from './imagenes-upc.ts';
import { codigoLeido, normalizarUpc } from '../public/upc.js';
import { procesarRecortes } from './recortes.ts';
import { procesarColaRopa } from './ropa-ia.ts';

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

test('la imagen cuyo código verificó la página de Target se confirma sola; una persona puede volver a confirmarla (#524)', async (t) => {
  const { db, pedir, esperar } = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    llamadas++;
    if (String(url).startsWith('https://target.scene7.com/')) return fotoTarget();
    assert.equal(String(url), `https://www.target.com/p/-/A-${TCIN}`);
    assert.equal(opciones.redirect, 'manual');
    // Ni sesión ni cookies del personal salen hacia Target.
    assert.deepEqual(Object.keys(opciones.headers as Record<string, string>).sort(), ['accept', 'user-agent']);
    return pagina(IMAGEN.replace('?', '?a=1&amp;'));
  });
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 409);
  const candidata = await pedir(RUTA, { url: 'http://127.0.0.1/secreto' });
  assert.equal(candidata.status, 200);
  assert.equal(candidata.cuerpo.imagen.codigo_verificado, true);
  assert.equal(candidata.cuerpo.imagen.confirmada, true);
  assert.equal(candidata.cuerpo.imagen.nombre, 'Yoobi & pouch');
  const IMAGEN_PAGINA = IMAGEN.replace('?', '?a=1&');
  assert.equal(candidata.cuerpo.imagen.url, IMAGEN_PAGINA);
  await esperar();
  // Se confirmó sola y ya bajó la imagen una vez (página + foto).
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, 'sistema');
  assert.equal(llamadas, 2);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA + 'otro', tcin: TCIN }, 'PUT')).status, 409);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA, tcin: TCIN }, 'PUT')).cuerpo.imagen.confirmada, true);
  await esperar();
  assert.equal((await pedir(RUTA, {})).cuerpo.imagen.confirmada, true);
  assert.equal((await pedir(`/api/manifiesto/${UPC}`, undefined, 'GET')).cuerpo.imagen.url, IMAGEN_PAGINA);
  assert.equal(llamadas, 2);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, DUENO);
  assert.equal(db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  db.prepare("update manifiesto set tcin='123'").run();
  assert.equal((await pedir(RUTA, undefined, 'GET')).cuerpo.imagen, null);
  assert.equal((await pedir(RUTA, { url: IMAGEN_PAGINA, tcin: TCIN }, 'PUT')).status, 409);
});

test('sin código en la página, la imagen también se confirma sola y da foto; con otro código se rechaza (#532)', async (t) => {
  const { db, pedir, esperar } = preparar();
  db.prepare("update productos set upc=?, estado_analisis='listo' where id=?").run('0' + UPC, PRODUCTO);
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    llamadas++;
    return String(url).startsWith('https://target.scene7.com/') ? fotoTarget() : pagina(IMAGEN, '');
  });
  const candidata = await pedir(RUTA, {});
  assert.equal(candidata.status, 200);
  assert.equal(candidata.cuerpo.imagen.codigo_verificado, false);
  assert.equal(candidata.cuerpo.imagen.confirmada, true);
  await esperar();
  assert.equal(llamadas, 2);
  const fila = db.prepare('select confirmado_por, confirmado_en from imagenes_upc').get()!;
  assert.equal(fila.confirmado_por, 'sistema');
  assert.ok(fila.confirmado_en > '2026');
  assert.equal(db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, `fotos/${PRODUCTO}.jpg`);
});

test('una candidata sin confirmar se confirma sola al leerla por UPC (#532)', async (t) => {
  const { db, pedir } = preparar();
  candidata(db);
  const fetchear = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no debe salir a Target'); });
  const leida = await pedir(RUTA, undefined, 'GET');
  assert.equal(leida.cuerpo.imagen.confirmada, true);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, 'sistema');
  assert.ok(db.prepare('select confirmado_en from imagenes_upc').get()!.confirmado_en > '2026');
  assert.equal(fetchear.mock.calls.length, 0);
});

function candidata(db: ReturnType<typeof preparar>['db'], confirmada = false, url = IMAGEN) {
  db.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, confirmado_en)
    values (?, ?, ?, 'Referencia Target', ?)`).run(UPC, TCIN, url, confirmada ? '2026-10-21' : '');
}

const bytesFoto = new Uint8Array([255, 216, 255, 1]);
const fotoTarget = () => new Response(bytesFoto, { headers: { 'content-type': 'image/jpeg' } });

// #413: piezas anteriores a la copia en vivo, sin pasar por el escáner.
function piezaAnterior(db: ReturnType<typeof preparar>['db'], numero: number) {
  const id = crypto.randomUUID(), upc = String(8438051051000 + numero), url = `${IMAGEN}&pieza=${numero}`;
  const confirmadoEn = new Date(Date.UTC(2026, 9, 20, 0, 0, numero)).toISOString();
  db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, actualizado_en) values (?, 'Estuche', 999, ?, '')`).run(upc, TCIN);
  db.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, confirmado_en) values (?, ?, ?, 'Estuche', ?)`)
    .run(upc, TCIN, url, confirmadoEn);
  db.prepare(`insert into productos (id, upc, nombre, precio, stock, estado_analisis, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Estuche', 123, 2, 'listo', 'S40', '2026-10-01', '2026-10-01')`).run(id, upc);
  return { id, upc, url, confirmadoEn };
}

test('el cron da foto a una pieza vieja y al ponerse al día solo consulta el lote sin tocar R2', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  db.prepare("update productos set upc=?, estado_analisis='listo', creado_en='2026-10-01' where id=?").run('0' + UPC, PRODUCTO);
  candidata(db, true);
  const antes = db.prepare('select nombre, precio, stock, estado_analisis, codigo from productos where id=?').get(PRODUCTO);
  const descargar = t.mock.method(globalThis, 'fetch', async () => fotoTarget());
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, `fotos/${PRODUCTO}.jpg`);
  assert.deepEqual(new Uint8Array(await (await env.FOTOS.get(`fotos/${PRODUCTO}.jpg`))!.arrayBuffer()), bytesFoto);
  assert.deepEqual(db.prepare('select nombre, precio, stock, estado_analisis, codigo from productos where id=?').get(PRODUCTO), antes);
  assert.equal(db.prepare("select valor from config where clave='imagenes_relleno_hasta'").get()!.valor, '2026-10-21');
  const consultarFoto = t.mock.method(env.FOTOS, 'get');
  const prepararSql = env.DB.prepare.bind(env.DB), consultas: string[] = [];
  t.mock.method(env.DB, 'prepare', (sql: string) => { consultas.push(sql); return prepararSql(sql); });
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(descargar.mock.calls.length, 1);
  assert.equal(consultarFoto.mock.calls.length, 0);
  // #524: el barrido de candidatas verificadas más el lote; ninguno toca productos.
  const lote = consultas.filter((sql) => sql.includes('imagenes_upc'));
  assert.equal(lote.length, 2);
  for (const sql of lote) assert.doesNotMatch(sql, /productos/i);
  assert.ok(!consultas.some((sql) => /insert into config/i.test(sql)));
});

test('el cron procesa hasta 20 confirmaciones en orden y descarga una imagen a la vez', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const piezas = Array.from({ length: 21 }, (_, i) => piezaAnterior(db, 21 - i)).reverse();
  const llamadas: string[] = [];
  let activas = 0, maximo = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    llamadas.push(String(url)); maximo = Math.max(maximo, ++activas);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activas--; return fotoTarget();
  });
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.deepEqual(llamadas, piezas.slice(0, 20).map((p) => p.url));
  assert.equal(maximo, 1);
  assert.equal(db.prepare("select count(*) n from productos where foto_key<>''").get()!.n, 20);
  assert.equal(db.prepare("select valor from config where clave='imagenes_relleno_hasta'").get()!.valor, piezas[19].confirmadoEn);
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.deepEqual(llamadas, piezas.map((p) => p.url));
  assert.equal(db.prepare('select foto_key from productos where id=?').get(piezas[20].id)!.foto_key, `fotos/${piezas[20].id}.jpg`);
  assert.equal(db.prepare("select valor from config where clave='imagenes_relleno_hasta'").get()!.valor, piezas[20].confirmadoEn);
});

test('una descarga fallida se registra y no frena el lote ni el cursor; otro escaneo reintenta', async (t) => {
  const { db, env, ctx, esperar, pedir } = preparar();
  const fallida = piezaAnterior(db, 1), siguiente = piezaAnterior(db, 2);
  const errores = t.mock.method(console, 'error', () => {});
  const descargar = t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url) === fallida.url) throw new DOMException('Timeout', 'TimeoutError');
    return fotoTarget();
  });
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(fallida.id)!.foto_key, '');
  assert.equal(db.prepare('select foto_key from productos where id=?').get(siguiente.id)!.foto_key, `fotos/${siguiente.id}.jpg`);
  assert.equal(db.prepare("select valor from config where clave='imagenes_relleno_hasta'").get()!.valor, siguiente.confirmadoEn);
  assert.equal(JSON.parse(errores.mock.calls[0].arguments[0]).upc, fallida.upc);
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(descargar.mock.calls.length, 2);
  t.mock.method(globalThis, 'fetch', async () => fotoTarget());
  await pedir('/api/borradores/upc', { id: fallida.id, upc: fallida.upc, stock: 2 }); await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(fallida.id)!.foto_key, `fotos/${fallida.id}.jpg`);
});

test('el relleno conserva fotos propias, excluye FEP y descartados y confirma las candidatas (#532)', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const propia = piezaAnterior(db, 1), fep = piezaAnterior(db, 2), descartada = piezaAnterior(db, 3), sinConfirmar = piezaAnterior(db, 4);
  const fotoKey = `fotos/${propia.id}.jpg`;
  db.prepare('update productos set foto_key=? where id=?').run(fotoKey, propia.id);
  await env.FOTOS.put(fotoKey, new Uint8Array([7, 8]));
  db.prepare("update productos set propietario='fep' where id=?").run(fep.id);
  db.prepare("update productos set estado_analisis='descartado' where id=?").run(descartada.id);
  db.prepare("update imagenes_upc set confirmado_en='' where upc=?").run(sinConfirmar.upc);
  const antes = db.prepare('select * from productos order by id').all();
  const descargar = t.mock.method(globalThis, 'fetch', async () => fotoTarget());
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(descargar.mock.calls.length, 4);
  const despues = db.prepare('select * from productos order by id').all();
  // Solo la pieza de la candidata recibe foto; las demás quedan idénticas.
  assert.deepEqual(despues.filter((p) => p.id !== sinConfirmar.id), antes.filter((p) => p.id !== sinConfirmar.id));
  assert.equal(db.prepare('select foto_key from productos where id=?').get(sinConfirmar.id)!.foto_key, `fotos/${sinConfirmar.id}.jpg`);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc where upc=?').get(sinConfirmar.upc)!.confirmado_por, 'sistema');
  assert.deepEqual(new Uint8Array(await (await env.FOTOS.get(fotoKey))!.arrayBuffer()), new Uint8Array([7, 8]));
  for (const p of [fep, descartada]) assert.equal(await env.FOTOS.get(`fotos/${p.id}.jpg`), null);
  assert.equal(await env.FOTOS.get(`fotos/${sinConfirmar.id}.jpg`) !== null, true);
  // La candidata confirmada hoy es la última del orden: el cursor llega a su confirmación.
  assert.equal(db.prepare("select valor from config where clave='imagenes_relleno_hasta'").get()!.valor,
    db.prepare('select confirmado_en from imagenes_upc where upc=?').get(sinConfirmar.upc)!.confirmado_en);
});

test('el cron confirma como «sistema» toda candidata que nadie tocó, con o sin código, y les da foto (#532)', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const rezagada = piezaAnterior(db, 1), sinCodigo = piezaAnterior(db, 2);
  db.prepare("update imagenes_upc set confirmado_en='', upc_fuente=upc where upc=?").run(rezagada.upc);
  db.prepare("update imagenes_upc set confirmado_en='' where upc=?").run(sinCodigo.upc);
  t.mock.method(globalThis, 'fetch', async () => fotoTarget());
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  for (const p of [rezagada, sinCodigo]) {
    const confirmada = db.prepare('select confirmado_por, confirmado_en from imagenes_upc where upc=?').get(p.upc)!;
    assert.equal(confirmada.confirmado_por, 'sistema');
    assert.ok(confirmada.confirmado_en > '2026');
    assert.equal(db.prepare('select foto_key from productos where id=?').get(p.id)!.foto_key, `fotos/${p.id}.jpg`);
  }
});

test('confirmar guarda una sola descarga en R2 y da foto al catálogo y ML sin quitar fondo ni cambiar la pieza (#423)', async (t) => {
  const { db, env, pedir, esperar } = preparar();
  db.prepare("update productos set upc=?, estado_analisis='listo', destino='etiqueta', categoria='ropa', nombre='Ropa' where id=?").run('0' + UPC, PRODUCTO);
  candidata(db);
  const antes = db.prepare('select nombre, precio, stock, estado_analisis, estado_fisico, codigo from productos where id=?').get(PRODUCTO);
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    llamadas++;
    assert.equal(String(url), IMAGEN);
    assert.equal(opciones.redirect, 'manual');
    assert.ok(opciones.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(opciones.headers as Record<string, string>).sort(), ['accept', 'user-agent']);
    return fotoTarget();
  });
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 200);
  await esperar();
  const fotoKey = db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key;
  assert.equal(fotoKey, `fotos/${PRODUCTO}.jpg`);
  assert.deepEqual(new Uint8Array(await (await env.FOTOS.get(String(fotoKey)))!.arrayBuffer()), bytesFoto);
  assert.deepEqual(db.prepare('select nombre, precio, stock, estado_analisis, estado_fisico, codigo from productos where id=?').get(PRODUCTO), antes);
  assert.equal((await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT')).status, 200);
  const id = crypto.randomUUID();
  assert.equal((await pedir('/api/borradores/upc', { id, upc: UPC, stock: 2 })).status, 201);
  await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(PRODUCTO)!.foto_key, `fotos/${PRODUCTO}.jpg`);
  assert.equal(db.prepare('select id from productos where id=?').get(id), undefined);
  assert.equal(llamadas, 1);
  env.HOST_PORTAL = 'portal.prueba';
  const publica = await worker.fetch!(new Request('https://portal.prueba/api/catalogo/foto/ED-000001') as never, env, {} as never);
  assert.equal(publica.status, 200);
  assert.deepEqual(new Uint8Array(await publica.arrayBuffer()), bytesFoto);
  const ml = await pedir('/api/ml/piezas', undefined, 'GET');
  assert.equal(ml.status, 200);
  assert.ok(JSON.stringify(ml.cuerpo).includes(PRODUCTO));
  db.prepare("insert into config (clave,valor) values ('recortes_activo','1'), ('ropa_ia_activo','1')").run();
  let recortes = 0;
  env.IMAGES = { input() { recortes++; return { transform() { return { output: async () => fotoTarget() }; } }; } } as never;
  await procesarRecortes(env);
  assert.equal(recortes, 0);
  assert.equal(db.prepare('select recorte_estado from productos where id=?').get(PRODUCTO)?.recorte_estado, 'original');
  await procesarColaRopa(env, async () => { assert.fail('La imagen de referencia no debe disparar análisis de ropa'); });
  assert.deepEqual({ ...db.prepare('select nombre, precio, stock, estado_analisis, estado_fisico, codigo from productos where id=?').get(PRODUCTO) }, { ...antes, stock:52 });
});

test('confirmar antes de capturar cachea la foto; candidata y TCIN cambiado no se importan', async (t) => {
  const { db, env, pedir, esperar } = preparar();
  candidata(db);
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => { llamadas++; return fotoTarget(); });
  const guardar = (estado_fisico = 'nuevo') => pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: UPC, stock: 1, estado_fisico });
  const sinConfirmar = await guardar(); await esperar();
  assert.equal(llamadas, 0);
  db.prepare('delete from productos where id=?').run(sinConfirmar.cuerpo.id);
  await pedir(RUTA, { url: IMAGEN, tcin: TCIN }, 'PUT'); await esperar();
  const nueva = await guardar(); await esperar();
  assert.equal(llamadas, 1);
  assert.ok(await env.FOTOS.get(`fotos/${nueva.cuerpo.id}.jpg`));
  db.prepare("update manifiesto set tcin='123'").run();
  const cambiada = await guardar('danado'); await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(cambiada.cuerpo.id)!.foto_key, '');
  assert.equal(llamadas, 1);
});

test('el escáner guarda sin esperar HTTP; una foto propia tardía, FEP y descartados se conservan', async (t) => {
  const { db, env, pedir, esperar } = preparar();
  candidata(db, true);
  db.prepare("update productos set upc=?, propietario='fep' where id=?").run(UPC, PRODUCTO);
  let responder!: (r: Response) => void;
  let llamadas = 0;
  const pendiente = new Promise<Response>((resolve) => { responder = resolve; });
  t.mock.method(globalThis, 'fetch', () => { llamadas++; return pendiente; });
  const id = crypto.randomUUID(), descartada = crypto.randomUUID();
  assert.equal((await pedir('/api/borradores/upc', { id, upc: UPC, stock: 2 })).status, 201);
  assert.equal((await pedir('/api/borradores/upc', { id: descartada, upc: UPC, stock: 1, estado_fisico:'danado' })).status, 201);
  db.prepare("update productos set estado_analisis='descartado' where id=?").run(descartada);
  await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([7, 8]));
  db.prepare('update productos set foto_key=? where id=?').run(`fotos/${id}.jpg`, id);
  responder(fotoTarget()); await esperar();
  assert.equal(llamadas, 1);
  assert.deepEqual(new Uint8Array(await (await env.FOTOS.get(`fotos/${id}.jpg`))!.arrayBuffer()), new Uint8Array([7, 8]));
  for (const excluida of [PRODUCTO, descartada]) assert.equal(db.prepare('select foto_key from productos where id=?').get(excluida)!.foto_key, '');
});

test('foto propia en vuelo y referencia cambiada durante HTTP no se pisan', async (t) => {
  for (const cambio of ['foto', 'tcin', 'descarte', 'fep']) {
    const { db, env, pedir, esperar } = preparar();
    candidata(db, true);
    let responder!: (r: Response) => void;
    let iniciada!: () => void;
    const inicio = new Promise<void>((resolve) => { iniciada = resolve; });
    t.mock.method(globalThis, 'fetch', () => { iniciada(); return new Promise<Response>((resolve) => { responder = resolve; }); });
    const id = crypto.randomUUID();
    await pedir('/api/borradores/upc', { id, upc: UPC, stock: 1 });
    await inicio;
    if (cambio === 'tcin') db.prepare("update manifiesto set tcin='123'").run();
    if (cambio === 'descarte') db.prepare("update productos set estado_analisis='descartado' where id=?").run(id);
    if (cambio === 'fep') db.prepare("update productos set propietario='fep' where id=?").run(id);
    // R2 ya tiene la foto propia, pero su UPDATE aún no llegó: también debe conservarse.
    if (cambio === 'foto') await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([7]));
    responder(fotoTarget()); await esperar();
    assert.equal(db.prepare('select foto_key from productos where id=?').get(id)!.foto_key, '');
    if (cambio === 'foto') assert.deepEqual(new Uint8Array(await (await env.FOTOS.get(`fotos/${id}.jpg`))!.arrayBuffer()), new Uint8Array([7]));
    if (cambio === 'tcin') {
      db.prepare('update manifiesto set tcin=?').run(TCIN);
      db.prepare('update imagenes_upc set url=?').run(IMAGEN + '&nueva=1');
      t.mock.method(globalThis, 'fetch', async () => fotoTarget());
      await pedir('/api/borradores/upc', { id, upc: UPC, stock: 1 }); await esperar();
      assert.equal(db.prepare('select foto_key from productos where id=?').get(id)!.foto_key, `fotos/${id}.jpg`);
    }
  }
});

test('un fallo de R2 se recupera desde la caché y conserva content-type de imagen', async (t) => {
  const { db, env, pedir, esperar } = preparar();
  candidata(db, true);
  let descargas = 0, fallar = true;
  t.mock.method(globalThis, 'fetch', async () => { descargas++; return new Response(bytesFoto, { headers: { 'content-type': 'image/png' } }); });
  const put = env.FOTOS.put.bind(env.FOTOS);
  t.mock.method(env.FOTOS, 'put', async (key: string, valor: BodyInit, opciones: R2PutOptions) => {
    if (key.startsWith('fotos/') && fallar) { fallar = false; throw new Error('R2 no disponible'); }
    return put(key, valor as never, opciones);
  });
  const id = crypto.randomUUID(), cuerpo = { id, upc: UPC, stock: 1 };
  await pedir('/api/borradores/upc', cuerpo); await esperar();
  assert.equal(db.prepare('select foto_key from productos where id=?').get(id)!.foto_key, '');
  await pedir('/api/borradores/upc', cuerpo); await esperar();
  assert.equal(descargas, 1);
  assert.equal((await env.FOTOS.get(`fotos/${id}.jpg`))!.httpMetadata?.contentType, 'image/png');
  const foto = await worker.fetch!(new Request(`https://caja.prueba/api/foto/${id}`) as never, env, {} as never);
  assert.equal(foto.status, 200); assert.equal(foto.headers.get('content-type'), 'image/png');
});

test('descargas inválidas o fallidas no afectan captura ni foto; el reenvío reintenta sin reponer stock', async (t) => {
  for (const respuesta of [
    () => new Response(null, { status: 302, headers: { location: 'https://otro.mx/foto' } }),
    () => new Response('no', { status: 500 }),
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response(bytesFoto, { headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(6 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    () => new Response(null, { headers: { 'content-type': 'image/jpeg' } }),
    () => { throw new DOMException('Timeout', 'TimeoutError'); },
  ]) {
    const { db, env, pedir, esperar } = preparar();
    candidata(db, true);
    t.mock.method(globalThis, 'fetch', async () => respuesta());
    const id = crypto.randomUUID(), cuerpo = { id, upc: UPC, stock: 3 };
    assert.equal((await pedir('/api/borradores/upc', cuerpo)).status, 201);
    await esperar();
    assert.equal(db.prepare('select foto_key from productos where id=?').get(id)!.foto_key, '');
    assert.equal(await env.FOTOS.get(`fotos/${id}.jpg`), null);
    db.prepare('update productos set stock=1, precio=123 where id=?').run(id);
    t.mock.method(globalThis, 'fetch', async () => fotoTarget());
    assert.equal((await pedir('/api/borradores/upc', cuerpo)).status, 201);
    await esperar();
    const guardada = db.prepare('select foto_key, stock, precio, estado_analisis from productos where id=?').get(id)!;
    assert.equal(guardada.foto_key, `fotos/${id}.jpg`);
    assert.equal(guardada.stock, 1); assert.equal(guardada.precio, 123); assert.equal(guardada.estado_analisis, 'listo');
  }
});

test('la descarga vuelve a validar URL guardada: solo HTTPS y el filtro de imagenValida', async (t) => {
  for (const url of ['http://target.scene7.com/is/image/Target/x', 'https://target.scene7.com.evil.mx/is/image/Target/x',
    'https://usuario:clave@target.scene7.com/is/image/Target/x', 'https://target.scene7.com:444/is/image/Target/x', 'https://target.scene7.com/otra/x']) {
    const { db, pedir, esperar } = preparar();
    candidata(db, true, url);
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('No debe salir HTTP'); });
    await pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: UPC, stock: 1 }); await esperar();
    assert.equal(db.prepare("select count(*) n from productos where foto_key<>''").get()!.n, 0);
  }
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
  // #718: UPCitemdb también falla aquí (500): solo las respuestas de Target salen de la cola.
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).includes('target.com') ? respuestas.shift()! : new Response('no', { status: 500 }));
  const status = [];
  for (let i = 0; i < 7; i++) status.push((await pedir(RUTA, {})).status);
  assert.deepEqual(status, [422, 422, 422, 422, 502, 502, 502]);
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  assert.equal((await pedir('/api/manifiesto/123456789012/imagen', {})).status, 404);
});

test('la verificación «mantén presionado» de Target pausa las consultas en vez de insistir', async (t) => {
  const { db, pedir } = preparar();
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    // #718: el respaldo de UPCitemdb (que aquí también falla) no cuenta como insistir en Target.
    if (!String(url).includes('target.com')) return new Response('no', { status: 500 });
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

test('#549: la foto con el id y UPC de una pieza que ya tiene imagen no la pisa; un reintento sin foto sí la sube', async () => {
  const { db, env, pedir } = preparar();
  const id = crypto.randomUUID(), key = `fotos/${id}.jpg`;
  assert.equal((await pedir('/api/borradores/upc', { id, upc: UPC, stock: 1 })).status, 201);
  // La imagen del catálogo ya quedó como foto de la pieza.
  await env.FOTOS.put(key, 'catalogo', { customMetadata: { imagen_upc: 'imagenes-upc/x' } });
  db.prepare('update productos set foto_key=? where id=?').run(key, id);
  const subir = async () => {
    const cuerpo = new FormData();
    cuerpo.set('id', id); cuerpo.set('upc', UPC); cuerpo.set('cantidad', '1'); cuerpo.set('estado_fisico', 'nuevo');
    cuerpo.set('foto', new File(['playera'], 'foto.jpg', { type: 'image/jpeg' }));
    return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, env, { waitUntil() {} } as never);
  };
  assert.equal((await subir()).status, 201);
  assert.equal(new TextDecoder().decode((env.FOTOS as any).objetos.get(key)), 'catalogo');
  assert.equal(db.prepare('select foto_key, stock from productos where id=?').get(id)!.foto_key, key);
  assert.equal(db.prepare('select stock from productos where id=?').get(id)!.stock, 1);
  // Reintento legítimo: el alta quedó sin foto (falló el put) y la misma subida la repone.
  await env.FOTOS.delete(key);
  db.prepare("update productos set foto_key='' where id=?").run(id);
  assert.equal((await subir()).status, 201);
  assert.equal(new TextDecoder().decode((env.FOTOS as any).objetos.get(key)), 'playera');
  assert.equal(db.prepare('select foto_key from productos where id=?').get(id)!.foto_key, key);
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
  assert.equal(db.prepare('select id from productos where id=?').get(id), undefined);
  assert.equal(db.prepare('select precio from productos where id=?').get(PRODUCTO)!.precio, 25000);
  assert.equal(db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 52);
});

// ---- #718: UPCitemdb como fuente de imagen por UPC ----
pausarUpcitemdbPor(0);
const SCENE7 = 'https://target.scene7.com/is/image/Target/GUEST_upcitemdb';
const AJENA = 'https://m.media-amazon.com/images/I/foto.jpg';
const hoy = () => new Date().toISOString().slice(0, 10);
const item = (upc: string, images: string[], extra: Record<string, unknown> = {}) =>
  ({ ean: upc.padStart(13, '0'), upc, title: 'Estuche UPCitemdb', brand: 'Yoobi', model: TCIN, images, ...extra });
const respuestaUpcitemdb = (items: unknown[]) => Response.json({ code: 'OK', total: items.length, items });

/** Simula UPCitemdb por UPC pedido; los CDN de imagen responden aparte y Target (u otra cosa) da 403. */
function simular(t: { mock: { method: (...args: any[]) => any } }, porUpc: (upc: string) => Response) {
  const consultas: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const u = String(url);
    if (u.startsWith('https://api.upcitemdb.com/prod/trial/lookup?upc=')) {
      consultas.push(new URL(u).searchParams.get('upc')!);
      return porUpc(consultas.at(-1)!);
    }
    if (u.startsWith('https://target.scene7.com/') || u.startsWith('https://m.media-amazon.com/')) return fotoTarget();
    return new Response('no', { status: 403 });
  });
  return { consultas };
}
function pieza(db: ReturnType<typeof preparar>['db'], upc: string, extra = '', stock = 2, creado = '2026-10-01') {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, upc, nombre, precio, stock, estado_analisis, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Estuche', 123, ?, 'listo', 'S40', ?, ?)`).run(id, upc, stock, creado, creado);
  if (extra) db.prepare(`update productos set ${extra} where id = ?`).run(id);
  return id;
}
const fotoDe = (db: ReturnType<typeof preparar>['db'], id: string) => db.prepare('select foto_key from productos where id=?').get(id)!.foto_key;

test('#718 cron: UPC en el manifiesto toma la imagen scene7 con el UPC coincidente y el TCIN de la hoja', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const id = pieza(db, '0' + UPC);
  const antes = db.prepare('select nombre, precio, stock, estado_analisis from productos where id=?').get(id);
  const avisos = t.mock.method(console, 'warn', () => {});
  const { consultas } = simular(t, () => respuestaUpcitemdb([item(UPC, [AJENA, SCENE7], { model: '999' })]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.deepEqual(consultas, [UPC]);
  const ref = db.prepare('select tcin, url, confirmado_por, upc_fuente from imagenes_upc where upc=?').get(UPC)!;
  assert.deepEqual({ ...ref }, { tcin: TCIN, url: SCENE7, confirmado_por: 'sistema', upc_fuente: UPC });
  assert.equal(fotoDe(db, id), `fotos/${id}.jpg`);
  assert.deepEqual(db.prepare('select nombre, precio, stock, estado_analisis from productos where id=?').get(id), antes);
  assert.match(String(avisos.mock.calls.map((c) => c.arguments[0]).find((m) => /model distinto/.test(String(m)))), /"model":"999"/);
  // Ya tiene foto: la siguiente corrida no consulta.
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 1);
  assert.equal(db.prepare('select valor from config where clave=?').get(`upcitemdb_consultas_${hoy()}`)!.valor, '1');
});

test('#718 cron: UPC que no coincide o sin imagen no da foto y no se vuelve a consultar', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const distinto = pieza(db, '111111111111'), sinImagen = pieza(db, '222222222222'), vacio = pieza(db, '333333333333');
  const { consultas } = simular(t, (upc) => upc === '111111111111' ? respuestaUpcitemdb([item('999999999999', [SCENE7])])
    : upc === '222222222222' ? respuestaUpcitemdb([item(upc, ['http://inseguro.mx/a.jpg'])]) : respuestaUpcitemdb([]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 3);
  for (const id of [distinto, sinImagen, vacio]) assert.equal(fotoDe(db, id), '');
  assert.equal(db.prepare("select count(*) n from config where clave like 'upcitemdb_sin_%'").get()!.n, 3);
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 3);
  // Pasados 30 días se vuelve a intentar.
  db.prepare("update config set valor='2000-01-01' where clave like 'upcitemdb_sin_%'").run();
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 6);
});

test('#718 cron: fuera del manifiesto da foto a todas las piezas de El Dolarón sin foto y respeta propias, FEP y descartadas', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const UPC2 = '555555555555';
  const a = pieza(db, UPC2), b = pieza(db, '0' + UPC2, "categoria = 'ropa', nombre = 'Ropa'", 0);
  const propia = pieza(db, UPC2, "foto_key = 'fotos/propia.jpg'"), fep = pieza(db, UPC2, "propietario = 'fep'");
  const descartada = pieza(db, UPC2, "estado_analisis = 'descartado'");
  const { consultas } = simular(t, () => respuestaUpcitemdb([item(UPC2, ['http://x.mx/a.jpg', AJENA, SCENE7])]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.deepEqual(consultas, [UPC2]);
  // Sin manifiesto no pasa por imagenes_upc; la imagen scene7 gana si está, aunque no sea la primera.
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  for (const id of [a, b]) {
    assert.equal(fotoDe(db, id), `fotos/${id}.jpg`);
    assert.equal((await env.FOTOS.get(`fotos/${id}.jpg`))!.customMetadata?.imagen_busqueda, SCENE7);
    assert.equal(db.prepare('select recorte_estado from productos where id=?').get(id)!.recorte_estado, 'original');
  }
  assert.equal(db.prepare('select ropa_ia_estado from productos where id=?').get(b)!.ropa_ia_estado, 'descartado');
  assert.equal(db.prepare('select ropa_ia_estado from productos where id=?').get(a)!.ropa_ia_estado, null);
  assert.equal(fotoDe(db, propia), 'fotos/propia.jpg');
  for (const id of [fep, descartada]) { assert.equal(fotoDe(db, id), ''); assert.equal(await env.FOTOS.get(`fotos/${id}.jpg`), null); }
});

test('#718 cron: sin imagen scene7 no guarda foto, marca el UPC y no vuelve a consultar', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const id = pieza(db, '666666666666');
  const { consultas } = simular(t, () => respuestaUpcitemdb([item('666666666666', ['http://x.mx/a.jpg', AJENA])]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 1);
  assert.equal(fotoDe(db, id), '');
  assert.equal(await env.FOTOS.get(`fotos/${id}.jpg`), null);
  assert.equal(db.prepare('select count(*) n from config where clave = ?').get('upcitemdb_sin_666666666666')!.n, 1);
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 1);
});

test('#718 cron: hasta 5 UPC por corrida, con stock primero; un 429 detiene la corrida sin marcarlos', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  const sinStock = pieza(db, '700000000000', '', 0, '2026-10-30');
  for (let i = 1; i <= 6; i++) pieza(db, String(700000000000 + i), '', 2, `2026-10-0${i}`);
  const { consultas } = simular(t, () => respuestaUpcitemdb([]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  // Las de stock, de la más nueva a la más vieja; la de stock cero (aunque sea la más reciente) espera.
  assert.deepEqual(consultas, ['700000000006', '700000000005', '700000000004', '700000000003', '700000000002']);
  assert.equal(fotoDe(db, sinStock), '');
  db.prepare("delete from config where clave like 'upcitemdb_sin_%'").run();
  t.mock.restoreAll();
  const limite = simular(t, () => new Response('{"code":"TOO_FAST"}', { status: 429 }));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(limite.consultas.length, 1);
  assert.equal(db.prepare("select count(*) n from config where clave like 'upcitemdb_sin_%'").get()!.n, 0);
});

test('#718 cron: con el presupuesto del día agotado no consulta; el contador de ayer se borra', async (t) => {
  const { db, env, ctx, esperar } = preparar();
  pieza(db, '800000000001');
  db.prepare("insert into config (clave, valor) values (?, '80'), ('upcitemdb_consultas_2000-01-01', '33')").run(`upcitemdb_consultas_${hoy()}`);
  const { consultas } = simular(t, () => respuestaUpcitemdb([]));
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 0);
  // Con 79 usadas queda exactamente una: la consulta gasta la última y borra los días anteriores.
  db.prepare('update config set valor = ? where clave = ?').run('79', `upcitemdb_consultas_${hoy()}`);
  pieza(db, '800000000002');
  await worker.scheduled!({} as never, env, ctx as never); await esperar();
  assert.equal(consultas.length, 1);
  assert.equal(db.prepare('select valor from config where clave=?').get(`upcitemdb_consultas_${hoy()}`)!.valor, '80');
  assert.equal(db.prepare("select count(*) n from config where clave = 'upcitemdb_consultas_2000-01-01'").get()!.n, 0);
});

test('#718 escaneo: si Target pide verificación, UPCitemdb da la imagen como referencia de sistema', async (t) => {
  const { db, pedir, esperar } = preparar();
  const id = pieza(db, UPC);
  const { consultas } = simular(t, () => respuestaUpcitemdb([item(UPC, [SCENE7])]));
  const r = await pedir(RUTA, {});
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.imagen.url, SCENE7);
  assert.equal(r.cuerpo.imagen.tcin, TCIN);
  assert.equal(r.cuerpo.imagen.confirmada, true);
  assert.equal(r.cuerpo.imagen.codigo_verificado, true);
  await esperar();
  assert.deepEqual(consultas, [UPC]);
  assert.equal(db.prepare('select confirmado_por from imagenes_upc').get()!.confirmado_por, 'sistema');
  assert.equal(fotoDe(db, id), `fotos/${id}.jpg`);
  // El siguiente escaneo ya no sale a ninguna parte.
  assert.equal((await pedir(RUTA, {})).cuerpo.imagen.url, `/api/manifiesto/${UPC}/imagen/catalogo`);
  assert.equal(consultas.length, 1);
});

test('#718 escaneo: UPCitemdb sin imagen scene7, con otro UPC, con 429 o sin presupuesto deja el aviso de Target', async (t) => {
  const { db, pedir } = preparar();
  const casos: Array<() => Response> = [
    () => respuestaUpcitemdb([item(UPC, [AJENA])]),
    () => respuestaUpcitemdb([item('999999999999', [SCENE7])]),
    () => new Response('{}', { status: 429 }),
  ];
  for (const caso of casos) {
    reiniciarPausaTarget();
    simular(t, caso);
    const r = await pedir(RUTA, {});
    assert.equal(r.status, 503);
    assert.match(r.cuerpo.error, /verificación/);
    t.mock.restoreAll();
  }
  assert.equal(db.prepare('select count(*) n from imagenes_upc').get()!.n, 0);
  db.prepare("insert or replace into config (clave, valor) values (?, '80')").run(`upcitemdb_consultas_${hoy()}`);
  reiniciarPausaTarget();
  const { consultas } = simular(t, () => respuestaUpcitemdb([item(UPC, [SCENE7])]));
  assert.equal((await pedir(RUTA, {})).status, 503);
  assert.equal(consultas.length, 0);
});

test('#718 escaneo: Target sin página (404) también prueba UPCitemdb y sigue pidiendo foto si no hay', async (t) => {
  const { pedir } = preparar();
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).includes('upcitemdb') ? respuestaUpcitemdb([]) : new Response('no', { status: 404 }));
  const r = await pedir(RUTA, {});
  assert.equal(r.status, 422);
  assert.match(r.cuerpo.error, /ya no tiene/);
});
