// node --test src/analisis.test.ts
// Si el modelo no contesta, el analisis termina solo y la fila queda en `error`, no en `pendiente`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { analizarBorrador, consultarGemini, LIMITES_MS } from './analisis.ts';
import { identificarPieza } from './worker.ts';

test('un modelo que nunca responde deja la fila en error (Claude y Gemini)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  const limitesOriginales = { ...LIMITES_MS };
  // Nunca responde; solo se entera de que lo cancelaron.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_ok, fallo) => {
    init?.signal?.addEventListener('abort', () => fallo(new Error('cancelado')));
  })) as typeof fetch;
  LIMITES_MS.claude = 50;
  LIMITES_MS.gemini = 50;
  t.after(() => { globalThis.fetch = fetchOriginal; Object.assign(LIMITES_MS, limitesOriginales); });
  (env as { ANTHROPIC_API_KEY: string; GEMINI_API_KEY: string }).ANTHROPIC_API_KEY = 'prueba';
  (env as { ANTHROPIC_API_KEY: string; GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';

  for (const modelo of ['claude', 'gemini'] as const) {
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(
      `insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
       values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    const inicio = Date.now();
    await analizarBorrador(id, env, modelo);
    assert.ok(Date.now() - inicio < 5000, `${modelo} tardo demasiado`);
    const fila = db.prepare('select estado_analisis from productos where id = ?').get(id) as { estado_analisis: string };
    assert.equal(fila.estado_analisis, 'error', modelo);
  }
});

test('un análisis sin nombre o con precio 0 queda en error, nunca listo (#335)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  const casos = [
    { nombre: '   ', precio_lista_mxn: 200, esperado: 'error', precioPositivo: true },
    { nombre: 'Licuadora', precio_lista_mxn: 0, esperado: 'error', precioPositivo: false },
    { nombre: 'Licuadora', precio_lista_mxn: 200, esperado: 'listo', precioPositivo: true },
  ];
  for (const caso of casos) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      nombre: caso.nombre, marca: '', categoria: 'hogar', precio_lista_mxn: caso.precio_lista_mxn, precio_venta_mxn: 0,
    }) }] } }] }))) as typeof fetch;
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(
      `insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
       values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    await analizarBorrador(id, env, 'gemini', false);
    const fila = db.prepare('select nombre, precio, estado_analisis, actualizado_en from productos where id = ?').get(id) as
      { nombre: string; precio: number; estado_analisis: string; actualizado_en: string };
    assert.equal(fila.estado_analisis, caso.esperado, JSON.stringify(caso));
    assert.equal(fila.precio > 0, caso.precioPositivo, JSON.stringify(caso));
    assert.notEqual(fila.actualizado_en, '');
  }
});

test('corregir una etiqueta no la deja lista sin nombre o sin precio (#335)', async () => {
  const { db, pedir } = tienda();
  const id = crypto.randomUUID();
  db.prepare(
    `insert into productos (id, nombre, precio, estado_analisis, destino, semana_ingreso, creado_en, actualizado_en)
     values (?, 'Licuadora', 0, 'error', 'etiqueta', 'S40', '', '')`).run(id);
  const estado = () => (db.prepare('select estado_analisis from productos where id = ?').get(id) as { estado_analisis: string }).estado_analisis;
  // La cola del admin (donde Isaac revisa la mercancia general) la sigue mostrando: sin filtro y con ?estado=error.
  for (const ruta of ['/api/borradores', '/api/borradores?estado=error']) {
    assert.ok(((await pedir(ruta)).cuerpo as { id: string }[]).some((p) => p.id === id), ruta);
  }
  assert.equal((await pedir(`/api/borradores/${id}`, { marca: 'Oster' }, 'PATCH')).status, 400);
  assert.equal((await pedir(`/api/borradores/${id}`, { nombre: ' ', precio: 5000 }, 'PATCH')).status, 400);
  assert.equal(estado(), 'error');
  assert.equal((await pedir(`/api/borradores/${id}`, { precio: 5000 }, 'PATCH')).status, 200);
  assert.equal(estado(), 'listo');
});

test('con VERTEX_API_KEY Gemini va por Vertex con busqueda y registra las fuentes (#363)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  const logOriginal = console.log;
  const logs: string[] = [];
  t.after(() => { globalThis.fetch = fetchOriginal; console.log = logOriginal; });
  console.log = (linea: string) => { logs.push(linea); };
  (env as { VERTEX_API_KEY: string }).VERTEX_API_KEY = 'llave-vertex';
  let url = '';
  let cuerpo: any;
  globalThis.fetch = (async (destino: string, init: RequestInit) => {
    url = destino;
    cuerpo = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{
      content: { parts: [{ text: '```json\n{"nombre":"Licuadora Oster","marca":"Oster","categoria":"hogar","precio_lista_mxn":899,"precio_venta_mxn":0,"confianza":0.9}\n```' }] },
      groundingMetadata: { groundingChunks: [{ web: { title: 'mercadolibre.com.mx' } }, { web: { title: 'amazon.com.mx' } }] },
    }] }));
  }) as typeof fetch;
  const id = crypto.randomUUID();
  await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
  db.prepare(
    `insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
     values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
  await analizarBorrador(id, env, 'gemini', true);

  assert.match(url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/[^:]+:generateContent\?key=llave-vertex$/);
  assert.equal(cuerpo.contents[0].role, 'user');
  assert.deepEqual(cuerpo.tools, [{ googleSearch: {} }]);
  assert.deepEqual(cuerpo.generationConfig, { thinkingConfig: { thinkingLevel: 'LOW' } });
  const fila = db.prepare('select nombre, precio_lista, estado_analisis from productos where id = ?').get(id) as
    { nombre: string; precio_lista: number; estado_analisis: string };
  assert.deepEqual({ ...fila }, { nombre: 'Licuadora Oster', precio_lista: 89900, estado_analisis: 'listo' });
  assert.deepEqual(JSON.parse(logs.find((l) => l.includes('analisis listo'))!).fuentes, ['mercadolibre.com.mx', 'amazon.com.mx']);
});

test('con nombre y sin precio busca el nombre en tiendas mexicanas; si no aparece queda aparte (#387)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  db.prepare("insert or replace into config (clave, valor) values ('pct_juguetes', '50')").run();
  for (const [precioHallado, confianza, esperado] of [[450, 0.8, 'listo'], [450, 0.2, 'error'], [0, 0.9, 'error']] as const) {
    const cuerpos: any[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const cuerpo = JSON.parse(String(init!.body));
      cuerpos.push(cuerpo);
      const busca = !!cuerpo.tools;
      const ficha = busca
        ? { nombre: 'Peluche perro', marca: '', categoria: 'juguetes', precio_lista_mxn: precioHallado, precio_venta_mxn: 0, confianza }
        : { nombre: 'Peluche perro', marca: 'FAO Schwarz', categoria: 'juguetes', precio_lista_mxn: 0, precio_venta_mxn: 0, confianza: 0.9 };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ficha) }] } }] }));
    }) as typeof fetch;
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(`insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
      values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    await analizarBorrador(id, env, 'gemini', false);
    assert.equal(cuerpos.length, 2);
    // La segunda llamada es solo texto, con el nombre y la marca que salieron de la foto.
    assert.deepEqual(cuerpos[1].tools, [{ googleSearch: {} }]);
    assert.match(cuerpos[1].contents[0].parts[0].text, /Peluche perro, marca FAO Schwarz/);
    const fila = db.prepare('select nombre, precio_lista, precio, estado_analisis from productos where id = ?').get(id) as any;
    assert.equal(fila.estado_analisis, esperado);
    assert.equal(fila.nombre, 'Peluche perro');
    if (esperado === 'listo') assert.deepEqual([fila.precio_lista, fila.precio], [45000, 23000]);   // $450 x 50 % = $225 -> $230
  }
});

test('la sugerencia por ejemplos solo manda con confianza alta; si no, el % de la categoría (#393)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  db.prepare("insert or replace into config (clave, valor) values ('pct_juguetes', '50')").run();
  for (let i = 0; i < 5; i++) {
    db.prepare(`insert into productos (id, nombre, categoria, precio_lista, precio, precio_sugerido, semana_ingreso, creado_en, actualizado_en)
      values (?, ?, 'juguetes', 20000, 7900, 9900, 'S40', '', '')`).run(crypto.randomUUID(), `Ejemplo ${i}`);
  }
  for (const [confianza, esperado] of [[0.55, 8000], [0.9, 5000]] as const) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      nombre: 'Muñeco Gigglescape', marca: 'Gigglescape', categoria: 'juguetes', precio_lista_mxn: 150, precio_venta_mxn: 50, confianza,
    }) }] } }] }))) as typeof fetch;
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(`insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
      values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    await analizarBorrador(id, env, 'gemini', false);
    // $150 x 50 % = $75 -> $80; la sugerencia de $50 solo con confianza alta.
    assert.equal((db.prepare('select precio from productos where id = ?').get(id) as { precio: number }).precio, esperado, String(confianza));
  }
});

test('foto con código y sin precio: va a la cola, que busca el código en cualquier tienda y convierte dólares (#397, #406)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const enviados: BusquedaUpc[] = [];
  Object.assign(env, { GEMINI_API_KEY: 'prueba', BUSQUEDAS: { send: async (m: BusquedaUpc) => { enviados.push(m); } } });
  db.prepare("insert or replace into config (clave, valor) values ('pct_juguetes', '50'), ('tipo_cambio', '1850')").run();
  const cuerpos: any[] = [];
  let foto = '';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const cuerpo = JSON.parse(String(init!.body));
    cuerpos.push(cuerpo);
    const ficha = cuerpo.tools
      ? { nombre: 'Bolsa peluche perro FAO Schwarz', marca: 'FAO Schwarz', categoria: 'juguetes', precio_lista_mxn: 0, precio_usd: 7.99, fuente: 'ebay.com', confianza: 0.9 }
      : { nombre: foto, marca: '', categoria: 'juguetes', precio_lista_mxn: 0, precio_venta_mxn: 0, confianza: 0.4 };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ficha) }] } }] }));
  }) as typeof fetch;
  for (const nombreFoto of ['Gorro tejido', '']) {   // la foto se equivoca o no da nombre; el código manda
    foto = nombreFoto;
    cuerpos.length = 0; enviados.length = 0;
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(`insert into productos (id, nombre, upc, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
      values (?, '', '840397509898', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    await analizarBorrador(id, env, 'gemini', false);
    // El análisis no busca: deja la pieza pendiente y la manda a la cola.
    assert.equal(cuerpos.filter((c) => c.tools).length, 0);
    assert.deepEqual(enviados, [{ id, upc: '840397509898' }]);
    assert.equal((db.prepare('select estado_analisis from productos where id = ?').get(id) as any).estado_analisis, 'pendiente');
    await identificarPieza(id, '840397509898', env, true);
    const busqueda = cuerpos.filter((c) => c.tools);
    assert.equal(busqueda[0].contents[0].parts[0].text, 'upc 840397509898');
    assert.match(busqueda[0].systemInstruction.parts[0].text, /eBay/);
    const fila = db.prepare('select nombre, precio_lista, precio, estado_analisis, codigo from productos where id = ?').get(id) as any;
    // US$7.99 x $18.50 = $148 de lista; 50 % = $74 -> $70, con el nombre del código.
    assert.deepEqual({ ...fila, codigo: !!fila.codigo },
      { nombre: 'Bolsa peluche perro FAO Schwarz', precio_lista: 14800, precio: 7000, estado_analisis: 'listo', codigo: true });
  }
});

test('sin hallazgo la cola deja la pieza aparte; un error de red se reintenta y solo el último intento la aparta (#406)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  Object.assign(env, { GEMINI_API_KEY: 'prueba' });
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, nombre, upc, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, 'Peluche gato', '840397509904', 'pendiente', 'x', 'S40', '', '')`).run(id);
  globalThis.fetch = (async () => { throw new Error('sin red'); }) as typeof fetch;
  await assert.rejects(identificarPieza(id, '840397509904', env, false));
  assert.equal((db.prepare('select estado_analisis from productos where id = ?').get(id) as any).estado_analisis, 'pendiente');
  await identificarPieza(id, '840397509904', env, true);
  assert.deepEqual({ ...db.prepare('select nombre, estado_analisis from productos where id = ?').get(id) as any },
    { nombre: 'Peluche gato', estado_analisis: 'error' });
});

test('sin precio pero con nombre seguro del código, la pieza va aparte con ese nombre (#409)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  Object.assign(env, { GEMINI_API_KEY: 'prueba' });
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, nombre, categoria, upc, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, 'Laptop Intel Core', 'electronica', '886144175480', 'pendiente', 'x', 'S40', '', '')`).run(id);
  for (const [confianza, nombre] of [[0.5, 'Laptop Intel Core'], [0.9, 'Peluche Mickey Mouse Just Play']] as const) {
    db.prepare("update productos set estado_analisis = 'pendiente', nombre = 'Laptop Intel Core' where id = ?").run(id);
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      nombre: 'Peluche Mickey Mouse Just Play', marca: 'Just Play', categoria: 'juguetes', precio_lista_mxn: 0, precio_usd: 0, fuente: 'toywiz.com', confianza,
    }) }] } }] }))) as typeof fetch;
    await identificarPieza(id, '886144175480', env, true);
    assert.deepEqual({ ...db.prepare('select nombre, estado_analisis from productos where id = ?').get(id) as any }, { nombre, estado_analisis: 'error' });
  }
});

test('consultarGemini: con modelo la URL de Vertex lleva ese modelo, sin VERTEX_API_KEY lanza y sin modelo es la de hoy (#888)', async (t) => {
  const { env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const urls: string[] = [];
  globalThis.fetch = (async (destino: string) => { urls.push(destino); return new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 7 } })); }) as typeof fetch;
  (env as { VERTEX_API_KEY: string }).VERTEX_API_KEY = 'llave-vertex';
  const respuesta = await consultarGemini(env, {}, 1000, 'gemini-prueba-imagen');
  assert.equal(respuesta.usageMetadata?.promptTokenCount, 7);
  await consultarGemini(env, {}, 1000);
  assert.equal(urls[0], 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-prueba-imagen:generateContent?key=llave-vertex');
  assert.match(urls[1], /models\/gemini-3\.8-flash:generateContent\?key=llave-vertex$/);
  // Con modelo, otra llave de Gemini no sirve: ese modelo solo existe en Vertex.
  delete (env as { VERTEX_API_KEY?: string }).VERTEX_API_KEY;
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'ai-studio';
  await assert.rejects(consultarGemini(env, {}, 1000, 'gemini-prueba-imagen'), /VERTEX_API_KEY/);
  assert.equal(urls.length, 2);
  await consultarGemini(env, {}, 1000);
  assert.match(urls[2], /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-flash-latest:generateContent\?key=ai-studio$/);
});

test('consultarGemini: sin el aviso de AI Studio la URL es la misma en toda combinación de llaves; con él y un modelo va a AI Studio (#900)', async (t) => {
  const { env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const urls: string[] = [];
  globalThis.fetch = (async (destino: string) => { urls.push(destino); return new Response('{}'); }) as typeof fetch;
  const llaves = env as { VERTEX_API_KEY?: string; GEMINI_API_KEY?: string; GEMINI2_API_KEY?: string };
  const VERTEX = (m: string) => `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent?key=v`;
  const STUDIO = (m: string, k: string) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`;
  // Quien ya llamaba (análisis, precio, UPC, «Buscar imagen») no pasa `aiStudio`: Vertex si hay VERTEX_API_KEY, aunque haya otra llave.
  for (const [gemini, gemini2] of [[undefined, undefined], ['g', undefined], [undefined, 'g2'], ['g', 'g2']] as const) {
    Object.assign(llaves, { VERTEX_API_KEY: 'v', GEMINI_API_KEY: gemini, GEMINI2_API_KEY: gemini2 });
    urls.length = 0;
    await consultarGemini(env, {}, 1000);
    await consultarGemini(env, {}, 1000, 'modelo-x');
    assert.deepEqual(urls, [VERTEX('gemini-3.8-flash'), VERTEX('modelo-x')]);
  }
  // Sin VERTEX_API_KEY: AI Studio sin modelo (como hoy); con modelo y sin `aiStudio` sigue lanzando.
  for (const [gemini, gemini2, llave] of [['g', undefined, 'g'], [undefined, 'g2', 'g2'], ['g', 'g2', 'g']] as const) {
    Object.assign(llaves, { VERTEX_API_KEY: undefined, GEMINI_API_KEY: gemini, GEMINI2_API_KEY: gemini2 });
    urls.length = 0;
    await consultarGemini(env, {}, 1000);
    assert.deepEqual(urls, [STUDIO('gemini-flash-latest', llave)]);
    await assert.rejects(consultarGemini(env, {}, 1000, 'modelo-x'), /VERTEX_API_KEY/);
    assert.equal(urls.length, 1);
    // Con `aiStudio` y modelo: AI Studio con ese modelo.
    await consultarGemini(env, {}, 1000, 'modelo-x', true);
    assert.equal(urls[1], STUDIO('modelo-x', llave));
  }
  // `aiStudio` gana a VERTEX_API_KEY; sin llave de AI Studio lanza sin llamar.
  Object.assign(llaves, { VERTEX_API_KEY: 'v', GEMINI_API_KEY: 'g', GEMINI2_API_KEY: undefined });
  urls.length = 0;
  await consultarGemini(env, {}, 1000, 'modelo-x', true);
  assert.deepEqual(urls, [STUDIO('modelo-x', 'g')]);
  Object.assign(llaves, { GEMINI_API_KEY: undefined });
  await assert.rejects(consultarGemini(env, {}, 1000, 'modelo-x', true), /GEMINI_API_KEY/);
  assert.equal(urls.length, 1);
});
