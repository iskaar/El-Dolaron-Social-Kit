// node --test src/gemini-aviso.test.ts
// #904: Gemini por AI Studio sin VERTEX_API_KEY: «Buscar imagen», aviso del último fallo en D1 y Vertex intacto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tienda } from './prueba-d1.ts';
import { analizarBorrador, identificarUpc, paginasParaImagen } from './analisis.ts';

// Con VERTEX_API_KEY nada cambia (el sandbox la sigue usando). La huella es de URL + cuerpo tal como salían antes del cambio.
test('con VERTEX_API_KEY la URL y el cuerpo de la búsqueda por UPC y de «Buscar imagen» no cambian (#904)', async (t) => {
  const { env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  (env as { VERTEX_API_KEY: string }).VERTEX_API_KEY = 'v';
  const vistas: Array<{ url: string; cuerpo: string }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    vistas.push({ url, cuerpo: String(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
  }) as typeof fetch;
  await identificarUpc('0012345678905', env);
  await paginasParaImagen('BARK Flapper Lantern', env);
  const VERTEX = 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent?key=v';
  assert.equal(vistas[0].url, VERTEX);
  assert.equal(createHash('sha256').update(vistas[0].cuerpo).digest('hex'), '466d0aac6d3a231fb7233539253401a1a2307b0aa3a93d3be709f1d20fdf36b8');
  assert.equal(vistas[1].url, VERTEX);
  assert.equal(vistas[1].cuerpo, JSON.stringify({
    systemInstruction: { parts: [{ text: 'Busca páginas de producto de tiendas o del fabricante para este artículo. Usa Google con la marca, el nombre y el código si lo hay.' }] },
    contents: [{ role: 'user', parts: [{ text: 'BARK Flapper Lantern' }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
  }));
});

// Sin llave de Vertex «Buscar imagen» va por AI Studio con el mismo alias que el resto, y sin ajuste de pensamiento
// (no está confirmado en la documentación para ese alias; ver el PR).
test('«Buscar imagen» sin VERTEX_API_KEY va por AI Studio con GEMINI_API_KEY o GEMINI2_API_KEY y sin thinkingConfig (#904)', async (t) => {
  const { env } = tienda();
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const llaves = env as { GEMINI_API_KEY?: string; GEMINI2_API_KEY?: string };
  const vistas: Array<{ url: string; cuerpo: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    vistas.push({ url, cuerpo: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://tienda.prueba/p' } }] } }] }));
  }) as typeof fetch;
  llaves.GEMINI_API_KEY = 'ai-studio';
  assert.deepEqual(await paginasParaImagen('BARK Flapper Lantern', env), ['https://tienda.prueba/p']);
  llaves.GEMINI_API_KEY = undefined; llaves.GEMINI2_API_KEY = 'ai-studio-2';
  await paginasParaImagen('BARK Flapper Lantern', env);
  assert.equal(vistas[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=ai-studio');
  assert.equal(vistas[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=ai-studio-2');
  for (const { cuerpo } of vistas) {
    assert.deepEqual(cuerpo.tools, [{ googleSearch: {} }]);
    assert.equal(JSON.stringify(cuerpo).includes('thinkingConfig'), false);
  }
  // Sin ninguna llave sigue lanzando, sin llamar.
  llaves.GEMINI2_API_KEY = undefined;
  await assert.rejects(paginasParaImagen('x', env), /llave de Gemini/);
  assert.equal(vistas.length, 2);
});

const aviso = (db: any) => db.prepare("select clave, valor from config where clave = 'gemini_ultimo_aviso'").all() as Array<{ clave: string; valor: string }>;
const fotoSinPrecio = (cuerpo: any) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
  nombre: 'Peluche perro', marca: '', categoria: 'juguetes', precio_lista_mxn: 0, precio_venta_mxn: 0, confianza: 0.9 }) }] } }] }));
async function borrador(p: ReturnType<typeof tienda>) {
  const id = crypto.randomUUID();
  await p.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
  p.db.prepare(`insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
  return id;
}

test('cada fallo de Gemini en precio por nombre, UPC y «Buscar imagen» deja UNA fila gemini_ultimo_aviso sin llave ni URL (#904)', async (t) => {
  const p = tienda();
  const { db, env } = p;
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'SECRETA';
  assert.equal(aviso(db).length, 0);

  // 1) precio por nombre: la foto sale bien, la búsqueda responde 500 con una URL con llave en el cuerpo.
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => JSON.parse(String(init!.body)).tools
    ? new Response('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=SECRETA ' + 'x'.repeat(400), { status: 500 })
    : fotoSinPrecio(init)) as typeof fetch;
  await analizarBorrador(await borrador(p), env, 'gemini', false);
  let filas = aviso(db);
  assert.equal(filas.length, 1);
  let datos = JSON.parse(filas[0].valor);
  assert.deepEqual(Object.keys(datos), ['en', 'que', 'status', 'mensaje']);
  assert.equal(datos.que, 'precio_por_nombre');
  assert.equal(datos.status, 500);
  assert.ok(!Number.isNaN(Date.parse(datos.en)));
  assert.ok(datos.mensaje.length <= 300);
  assert.match(datos.mensaje, /^Gemini 500/);
  assert.equal(filas[0].valor.includes('SECRETA'), false);

  // 2) UPC: fallo de red cuyo mensaje trae la URL con la llave; sin status.
  globalThis.fetch = (async (url: string) => { throw new Error(`fetch failed ${url}`); }) as typeof fetch;
  await assert.rejects(identificarUpc('0012345678905', env), /fetch failed/);
  filas = aviso(db);
  assert.equal(filas.length, 1);
  datos = JSON.parse(filas[0].valor);
  assert.equal(datos.que, 'busqueda_upc');
  assert.equal(datos.status, null);
  assert.match(datos.mensaje, /key=…/);
  assert.equal(filas[0].valor.includes('SECRETA'), false);

  // 3) «Buscar imagen»: 429.
  globalThis.fetch = (async () => new Response('cuota', { status: 429 })) as typeof fetch;
  await assert.rejects(paginasParaImagen('x', env), /Gemini 429/);
  filas = aviso(db);
  assert.equal(filas.length, 1);
  datos = JSON.parse(filas[0].valor);
  assert.deepEqual({ que: datos.que, status: datos.status }, { que: 'buscar_imagen', status: 429 });
  assert.equal(filas[0].valor.includes('SECRETA'), false);

  // Un éxito no escribe ni borra nada.
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }))) as typeof fetch;
  await paginasParaImagen('x', env);
  assert.equal(aviso(db).length, 1);
});

test('si D1 no deja guardar el aviso, el error original llega igual y el análisis termina como sin aviso (#904)', async (t) => {
  const p = tienda();
  const { db, env } = p;
  const fetchOriginal = globalThis.fetch;
  const errorOriginal = console.error;
  const avisoOriginal = console.warn;
  t.after(() => { globalThis.fetch = fetchOriginal; console.error = errorOriginal; console.warn = avisoOriginal; });
  console.error = () => {};
  console.warn = () => {};
  (env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  const dbReal = env.DB;
  (env as { DB: unknown }).DB = new Proxy(dbReal, { get: (o, prop) => prop === 'prepare'
    ? (sql: string) => { if (sql.includes('gemini_ultimo_aviso')) throw new Error('D1 caído'); return o.prepare(sql); }
    : (o as any)[prop] });
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => JSON.parse(String(init!.body)).tools
    ? new Response('no', { status: 503 })
    : fotoSinPrecio(init)) as typeof fetch;
  const id = await borrador(p);
  await analizarBorrador(id, env, 'gemini', false);
  const fila = db.prepare('select nombre, estado_analisis from productos where id = ?').get(id) as any;
  assert.deepEqual({ ...fila }, { nombre: 'Peluche perro', estado_analisis: 'error' });   // igual que sin el aviso: nombre sin precio queda aparte
  await assert.rejects(identificarUpc('0012345678905', env), /Gemini 503/);
  await assert.rejects(paginasParaImagen('x', env), /Gemini 503/);
  assert.equal(aviso(db).length, 0);
});
