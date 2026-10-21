// node --test src/analisis.test.ts
// Si el modelo no contesta, el analisis termina solo y la fila queda en `error`, no en `pendiente`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { analizarBorrador, LIMITES_MS } from './analisis.ts';

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
